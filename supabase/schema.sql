-- Run this once in the Supabase SQL editor (Project → SQL Editor → New query).

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null default 'Untitled project',
  data jsonb not null,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists projects_user_id_idx on public.projects(user_id);
create index if not exists projects_archived_idx on public.projects(archived);

-- Row Level Security: every user can only see/change their own projects.
alter table public.projects enable row level security;

create policy "Users can view their own projects"
  on public.projects for select
  using (auth.uid() = user_id);

create policy "Users can insert their own projects"
  on public.projects for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own projects"
  on public.projects for update
  using (auth.uid() = user_id);

create policy "Users can delete their own projects"
  on public.projects for delete
  using (auth.uid() = user_id);

-- ─────────────────────────────────────────────────────────────
-- Storage: room photos uploaded during the "Scan Furniture" step
-- (matches the documented flow — Supabase Storage holds the file,
-- the projects.data JSON only holds a path/URL reference to it).
-- ─────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('room-images', 'room-images', true)
on conflict (id) do nothing;

-- Files are stored under {user_id}/{project_id}/{wall}-{timestamp}.jpg — the policies
-- below check that the first path segment matches the signed-in user's id, so people can
-- only upload/read/delete their own photos. "public" bucket + these policies means anyone
-- with a direct link can view a photo (needed to render it back in the app), but only the
-- owner can write or delete.
create policy "Users can upload their own room photos"
  on storage.objects for insert
  with check (bucket_id = 'room-images' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "Users can view their own room photos"
  on storage.objects for select
  using (bucket_id = 'room-images' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "Users can update their own room photos"
  on storage.objects for update
  using (bucket_id = 'room-images' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "Users can delete their own room photos"
  on storage.objects for delete
  using (bucket_id = 'room-images' and (storage.foldername(name))[1] = auth.uid()::text);

-- ─────────────────────────────────────────────────────────────
-- ADMIN PANEL: role system + admin-only access.
-- Run the whole file once; this part adds:
--   • user_profiles.role ('user' | 'admin')
--   • is_admin() helper used by the app and by RLS
--   • security-definer functions the admin screen reads
--   • policies letting admins view/delete any project & photo
-- ─────────────────────────────────────────────────────────────
create table if not exists public.user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'user' check (role in ('user','admin')),
  created_at timestamptz not null default now()
);
alter table public.user_profiles enable row level security;

-- Returns true when the signed-in user has the admin role. Security definer
-- so RLS policies (which run as the caller) can safely rely on it.
-- NOTE: created BEFORE the policies below that reference it.
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists(
    select 1 from public.user_profiles p
    where p.user_id = auth.uid() and p.role = 'admin'
  );
$$;

-- Returns the signed-in user's own role as text.
create or replace function public.get_my_role() returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select p.role from public.user_profiles p where p.user_id = auth.uid()), 'user');
$$;

-- Every user can read their own profile row; admins can read all.
create policy "Users can view their own profile"
  on public.user_profiles for select
  using (auth.uid() = user_id);

create policy "Admins can view all profiles"
  on public.user_profiles for select
  using (public.is_admin());

-- Stamping a profile as admin is done by the app's owner with a SQL UPDATE
-- (see below), so no public insert/update policy is granted.

-- Admin only: list every account (email + signup date + role).
create or replace function public.admin_list_users()
returns table (id uuid, email text, role text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select u.id, u.email, coalesce(p.role,'user'), u.created_at
  from auth.users u
  left join public.user_profiles p on p.user_id = u.id
  where public.is_admin()
  order by u.created_at desc;
$$;

-- Admin only: list every project with its owner's email.
create or replace function public.admin_list_projects()
returns table (id uuid, name text, email text, updated_at timestamptz)
language sql stable security definer set search_path = public as $$
  select pr.id, pr.name, u.email, pr.updated_at
  from public.projects pr
  join auth.users u on u.id = pr.user_id
  where public.is_admin()
  order by pr.updated_at desc;
$$;

-- ── Widen project policies so admins can also view/delete any project.
drop policy if exists "Users can view their own projects" on public.projects;
create policy "Users can view their own projects"
  on public.projects for select
  using (auth.uid() = user_id or public.is_admin());

drop policy if exists "Users can delete their own projects" on public.projects;
create policy "Users can delete their own projects"
  on public.projects for delete
  using (auth.uid() = user_id or public.is_admin());

-- ── Widen storage so admins can view/delete any user's room photos.
drop policy if exists "Users can view their own room photos" on storage.objects;
create policy "Users can view their own room photos"
  on storage.objects for select
  using (bucket_id = 'room-images' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));

drop policy if exists "Users can delete their own room photos" on storage.objects;
create policy "Users can delete their own room photos"
  on storage.objects for delete
  using (bucket_id = 'room-images' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));

-- ─────────────────────────────────────────────────────────────
-- MAKE AN ADMIN (choose one user, run manually once):
--   insert into public.user_profiles (user_id, role)
--   values ('REPLACE_WITH_USER_UUID', 'admin')
--   on conflict (user_id) do update set role = 'admin';
-- Find the uuid: select id, email from auth.users;
-- ─────────────────────────────────────────────────────────────
