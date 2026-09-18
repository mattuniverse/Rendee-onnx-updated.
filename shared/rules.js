// Single source of truth for furniture dimensions and clearance rules — used by both the
// frontend (index.html, via build.js) and the backend (api/suggest-layout.js).
// Do not duplicate these values anywhere else.

// Canonical furniture definitions — all UI, placement, clearance, and 3D logic derives from this.
export const FURNITURE_DEFS = [
  {id:'door',label:'Door',icon:'\u{1F6AA}',cat:'Structure',w:0.9,h:0.15,color:'#8c6040',type:'door',h3d:2.1},
  {id:'window',label:'Window',icon:'\u{1FA9F}',cat:'Structure',w:1.2,h:0.1,color:'#8bb4d4',type:'window',h3d:1.2},
  {id:'sofa_2',label:'Sofa 2-seat',icon:'\u{1F6CB}',cat:'Seating',w:1.6,h:0.85,color:'#c4a282',type:'rect',h3d:0.8},
  {id:'sofa_3',label:'Sofa 3-seat',icon:'\u{1F6CB}',cat:'Seating',w:2.2,h:0.85,color:'#b89060',type:'rect',h3d:0.8},
  {id:'chair',label:'Chair',icon:'\u{1FA91}',cat:'Seating',w:0.6,h:0.6,color:'#c4a46b',type:'rect',h3d:0.9},
  {id:'armchair',label:'Armchair',icon:'\u{1FA91}',cat:'Seating',w:0.8,h:0.8,color:'#b89878',type:'rect',h3d:0.85},
  {id:'table_rect',label:'Table (rect)',icon:'\u2B1C',cat:'Tables',w:1.4,h:0.8,color:'#d4b896',type:'rect',h3d:0.75},
  {id:'table_round',label:'Table (round)',icon:'\u2B55',cat:'Tables',w:1,h:1,color:'#d4b896',type:'circle',h3d:0.75},
  {id:'desk',label:'Desk',icon:'\u{1F5D2}',cat:'Tables',w:1.2,h:0.6,color:'#b8a080',type:'rect',h3d:0.75},
  {id:'coffee',label:'Coffee Table',icon:'\u2615',cat:'Tables',w:1,h:0.5,color:'#c8a878',type:'rect',h3d:0.4},
  {id:'bed_s',label:'Single Bed',icon:'\u{1F6CF}',cat:'Beds',w:1,h:2,color:'#8ba7c7',type:'rect',h3d:0.5},
  {id:'bed_d',label:'Double Bed',icon:'\u{1F6CF}',cat:'Beds',w:1.6,h:2,color:'#6b8ab0',type:'rect',h3d:0.5},
  {id:'bed_k',label:'King Bed',icon:'\u{1F6CF}',cat:'Beds',w:2,h:2.1,color:'#5a7aa0',type:'rect',h3d:0.5},
  {id:'cabinet',label:'Cabinet',icon:'\u{1F5C4}',cat:'Storage',w:0.6,h:1.2,color:'#7a8f6e',type:'rect',h3d:1.8},
  {id:'wall_cab',label:'Wall Cabinet',icon:'\u{1F4E6}',cat:'Storage',w:0.9,h:0.35,color:'#8fa07a',type:'rect',h3d:0.7},
  {id:'wardrobe',label:'Wardrobe',icon:'\u{1F6AA}',cat:'Storage',w:1.8,h:0.6,color:'#7a6850',type:'rect',h3d:2},
  {id:'shelf',label:'Bookshelf',icon:'\u{1F4DA}',cat:'Storage',w:0.9,h:0.3,color:'#8c7860',type:'rect',h3d:1.8},
  {id:'sink',label:'Sink',icon:'\u{1F6BF}',cat:'Bathroom',w:0.6,h:0.5,color:'#8cc4d4',type:'rect',h3d:0.9},
  {id:'toilet',label:'Toilet',icon:'\u{1F6BD}',cat:'Bathroom',w:0.4,h:0.65,color:'#d0d8e0',type:'rect',h3d:0.8},
  {id:'bathtub',label:'Bathtub',icon:'\u{1F6C1}',cat:'Bathroom',w:0.8,h:1.7,color:'#b0ccd8',type:'rect',h3d:0.6},
  {id:'plant',label:'Plant',icon:'\u{1F33F}',cat:'Decor',w:0.5,h:0.5,color:'#5a9a4a',type:'circle',h3d:1.2},
  {id:'rug',label:'Rug',icon:'\u{1F532}',cat:'Decor',w:2,h:1.4,color:'#c0a890',type:'rect',h3d:0.02},
  {id:'tv',label:'TV Unit',icon:'\u{1F4FA}',cat:'Decor',w:1.4,h:0.4,color:'#4a4a4a',type:'rect',h3d:0.5},
];

// Derived size/height maps for backend (kept in sync with FURNITURE_DEFS)
export const SIZES = Object.fromEntries(FURNITURE_DEFS.map(d => [d.id, [d.w, d.h]]));
export const HEIGHTS = Object.fromEntries(FURNITURE_DEFS.map(d => [d.id, d.h3d]));

// Items that don't participate in clearance checks
export const PASSIVE_IDS = ['rug','tv','window','wall_cab','shelf','plant'];

// Clearance rules — single source for both frontend warnings and backend prompt hints
export const CLEARANCE_RULES = {
  pairs: [
    {from:['sofa_2','sofa_3','armchair'],to:['coffee'],min:0.35,ideal:0.45,label:'Seating to coffee table'},
    {from:['sofa_2','sofa_3','armchair'],to:['table_rect','table_round'],min:0.4,ideal:0.6,label:'Seating to table'},
    {from:['chair'],to:['table_rect','table_round','desk'],min:0.45,ideal:0.6,label:'Chair to table'}
  ],
  walkway:{min:0.75,ideal:0.9,label:'Walkway between furniture'},
  bedSide:{min:0.75,label:'Bed accessible side'},
  chairPull:{min:0.9,ideal:1.05,label:'Chair pulled-out space'},
  doorSwing:{margin:0.3,label:'Door swing arc'},
  windowFace:{margin:0.3,label:'Window front'}
};

// Placement anchor priority per room type
export const ANCHOR_ORDER = {
  'Living Room':['sofa_3','sofa_2','armchair','coffee','tv','chair'],
  'Bedroom':['bed_k','bed_d','bed_s','wardrobe','cabinet'],
  'Dining Room':['table_rect','table_round','chair','shelf'],
  'Kitchen':['table_rect','table_round','cabinet','sink'],
  'Bathroom':['bathtub','toilet','sink','cabinet'],
  'Office':['desk','chair','shelf','cabinet']
};

// Suggested starter layouts per room type (used by the "Try suggested layout" flow)
export const SUGGESTED_LAYOUTS = {
  'Living Room':{
    roomConfig:{type:'Living Room',shape:'rect',w:6,h:5,wallH:2.7,wallT:0.15,
      floor:{style:'wood',color:'#c8a878',pattern:'boards'},
      wallFinish:{style:'solid',color:'#ddd0be'}},
    walls:[
      {id:1,x1:0,y1:0,x2:6,y2:0,t:0.15,wh:2.7,label:'North'},
      {id:2,x1:6,y1:0,x2:6,y2:5,t:0.15,wh:2.7,label:'East'},
      {id:3,x1:6,y1:5,x2:0,y2:5,t:0.15,wh:2.7,label:'South'},
      {id:4,x1:0,y1:5,x2:0,y2:0,t:0.15,wh:2.7,label:'West'}],
    furniture:[
      {defId:'sofa_3',x:0.4,y:1.9,w:2.2,h:0.85,rot:0,h3d:0.8},
      {defId:'coffee',x:2.8,y:2.1,w:1.0,h:0.5,rot:0,h3d:0.4},
      {defId:'tv',x:4.5,y:1.8,w:1.4,h:0.4,rot:0,h3d:0.5},
      {defId:'chair',x:0.6,y:3.6,w:0.6,h:0.6,rot:0,h3d:0.9},
      {defId:'plant',x:5.3,y:0.4,w:0.5,h:0.5,rot:0,h3d:1.2},
      {defId:'rug',x:2.0,y:2.85,w:2.6,h:1.8,rot:0,h3d:0.02}]},
  'Bedroom':{
    roomConfig:{type:'Bedroom',shape:'rect',w:5,h:4.5,wallH:2.7,wallT:0.15,
      floor:{style:'carpet',color:'#b8aeb0',pattern:'plush'},
      wallFinish:{style:'solid',color:'#e8ddd2'}},
    walls:[
      {id:1,x1:0,y1:0,x2:5,y2:0,t:0.15,wh:2.7,label:'North'},
      {id:2,x1:5,y1:0,x2:5,y2:4.5,t:0.15,wh:2.7,label:'East'},
      {id:3,x1:5,y1:4.5,x2:0,y2:4.5,t:0.15,wh:2.7,label:'South'},
      {id:4,x1:0,y1:4.5,x2:0,y2:0,t:0.15,wh:2.7,label:'West'}],
    furniture:[
      {defId:'bed_k',x:1.3,y:0.3,w:2.0,h:2.2,rot:0,h3d:0.55},
      {defId:'wardrobe',x:3.8,y:0.3,w:1.0,h:0.6,rot:0,h3d:2.0},
      {defId:'cabinet',x:0.3,y:3.4,w:0.6,h:0.5,rot:0,h3d:0.9},
      {defId:'plant',x:4.4,y:3.8,w:0.4,h:0.4,rot:0,h3d:0.7}]},
  'Kitchen':{
    roomConfig:{type:'Kitchen',shape:'rect',w:4,h:3.5,wallH:2.7,wallT:0.15,
      floor:{style:'tile',color:'#d8d4cc',pattern:'ceramic'},
      wallFinish:{style:'solid',color:'#f0ebe3'}},
    walls:[
      {id:1,x1:0,y1:0,x2:4,y2:0,t:0.15,wh:2.7,label:'North'},
      {id:2,x1:4,y1:0,x2:4,y2:3.5,t:0.15,wh:2.7,label:'East'},
      {id:3,x1:4,y1:3.5,x2:0,y2:3.5,t:0.15,wh:2.7,label:'South'},
      {id:4,x1:0,y1:3.5,x2:0,y2:0,t:0.15,wh:2.7,label:'West'}],
    furniture:[
      {defId:'table_rect',x:1.2,y:1.5,w:1.0,h:0.7,rot:0,h3d:0.75},
      {defId:'cabinet',x:0.3,y:0.3,w:0.6,h:0.5,rot:0,h3d:0.9},
      {defId:'sink',x:3.2,y:0.3,w:0.7,h:0.5,rot:0,h3d:0.85}]},
  'Bathroom':{
    roomConfig:{type:'Bathroom',shape:'rect',w:3.5,h:2.5,wallH:2.7,wallT:0.15,
      floor:{style:'tile',color:'#c8c4bc',pattern:'hex'},
      wallFinish:{style:'solid',color:'#e8e4dc'}},
    walls:[
      {id:1,x1:0,y1:0,x2:3.5,y2:0,t:0.15,wh:2.7,label:'North'},
      {id:2,x1:3.5,y1:0,x2:3.5,y2:2.5,t:0.15,wh:2.7,label:'East'},
      {id:3,x1:3.5,y1:2.5,x2:0,y2:2.5,t:0.15,wh:2.7,label:'South'},
      {id:4,x1:0,y1:2.5,x2:0,y2:0,t:0.15,wh:2.7,label:'West'}],
    furniture:[
      {defId:'bathtub',x:1.6,y:0.3,w:1.7,h:0.8,rot:0,h3d:0.6},
      {defId:'toilet',x:0.3,y:1.5,w:0.45,h:0.7,rot:0,h3d:0.45},
      {defId:'sink',x:2.7,y:1.5,w:0.55,h:0.45,rot:0,h3d:0.85}]},
  'Office':{
    roomConfig:{type:'Office',shape:'rect',w:4,h:3.5,wallH:2.7,wallT:0.15,
      floor:{style:'concrete',color:'#a8b0b8',pattern:'polished'},
      wallFinish:{style:'solid',color:'#d8d4cc'}},
    walls:[
      {id:1,x1:0,y1:0,x2:4,y2:0,t:0.15,wh:2.7,label:'North'},
      {id:2,x1:4,y1:0,x2:4,y2:3.5,t:0.15,wh:2.7,label:'East'},
      {id:3,x1:4,y1:3.5,x2:0,y2:3.5,t:0.15,wh:2.7,label:'South'},
      {id:4,x1:0,y1:3.5,x2:0,y2:0,t:0.15,wh:2.7,label:'West'}],
    furniture:[
      {defId:'desk',x:0.3,y:0.3,w:1.4,h:0.7,rot:0,h3d:0.75},
      {defId:'chair',x:0.7,y:1.2,w:0.55,h:0.55,rot:0,h3d:0.9},
      {defId:'shelf',x:3.2,y:0.3,w:0.5,h:1.2,rot:0,h3d:1.8},
      {defId:'cabinet',x:3.2,y:2.5,w:0.6,h:0.5,rot:0,h3d:0.9}]}
};

// Room-type walkway minimums
export const WALKWAY_BY_TYPE = {
  bedroom: 0.9,
  'living room': 0.9,
  'dining room': 0.9,
  'home office': 0.9,
  kitchen: 1.0,
  'wheelchair friendly': 1.2,
  'elderly friendly': 0.9,
  'studio apartment': 0.9,
  nursery: 0.9,
};

// Role classification for interior rules
export const ROLES = {
  bed_s: 'bed', bed_d: 'bed', bed_k: 'bed',
  nightstand: 'nightstand',
  wardrobe: 'wardrobe', cabinet: 'wall_cab', wall_cab: 'wall_cab', shelf: 'wall_cab',
  sofa_2: 'sofa', sofa_3: 'sofa',
  armchair: 'seat', chair: 'chair',
  coffee: 'coffee',
  rug: 'rug',
  tv: 'tv',
  table_rect: 'table', table_round: 'table',
  desk: 'desk',
  plant: 'plant',
  toilet: 'bath', sink: 'bath', bathtub: 'bath',
};

// Bed ID lists
export const BED_IDS = ['bed_s', 'bed_d', 'bed_k'];
export const DOUBLE_BED_IDS = ['bed_d', 'bed_k'];

// Room types requiring egress checks
export const EGRESS_ROOM_TYPES = ['bedroom', 'nursery'];
export const ENGINEERING_SKIP_TYPES = ['bedroom', 'living room', 'nursery'];

// Constants
export const DEFAULT_SILL_HEIGHT = 0.9;
export const DEFAULT_WALKWAY = 0.9;
export const STRUCTURAL_CLEARANCE = 0.15;

export const DISCLAIMER =
  'Design suggestion only. Verify against local building code and consult a licensed professional before construction changes.';