import type { PrismaClient, Prisma } from "@event-platform/database";
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object=(v:unknown):Record<string,unknown>=>v&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:{};
type AuditRow=Prisma.StaffAuditGetPayload<{include:{staff:{select:{name:true,email:true}}}}>;
/** Resolve just this page in batches; never rewrite historical audit data. */
export async function auditPresentation(db:PrismaClient,rows:AuditRow[]) {
 const ids=(type:string)=>rows.filter(row=>row.targetType===type&&uuid.test(row.targetId)).map(row=>row.targetId);
 const staffIds=[...ids("staff"),...rows.flatMap(row=>[object(row.before).assignedStaffId,object(row.after).assignedStaffId].filter((v):v is string=>typeof v==="string"&&uuid.test(v)))];
 const [events,users,cases,applications,staff,orders,payouts]=await Promise.all([
  db.event.findMany({where:{id:{in:ids("event")}},select:{id:true,title:true}}),
  db.user.findMany({where:{id:{in:ids("user")}},select:{id:true,name:true,organizerProfile:{select:{organizationName:true}}}}),
  db.platformCase.findMany({where:{id:{in:ids("case")}},select:{id:true,subject:true}}),
  db.organizerVerification.findMany({where:{id:{in:ids("verification")}},select:{id:true,legalName:true}}),
  db.staffAccount.findMany({where:{id:{in:staffIds}},select:{id:true,name:true}}),
  db.order.findMany({where:{id:{in:ids("order")}},select:{id:true,checkoutSnapshot:true}}),
  db.organizerPayout.findMany({where:{id:{in:ids("payout")}},select:{id:true,reference:true}}),
 ]);
 const names=new Map<string,string>(),available=new Set<string>();
 const add=(type:string,id:string,name:string|null)=>{available.add(`${type}:${id}`);if(name)names.set(`${type}:${id}`,name);};
 events.forEach(v=>add("event",v.id,v.title));users.forEach(v=>add("user",v.id,v.organizerProfile?.organizationName||v.name));cases.forEach(v=>add("case",v.id,v.subject));applications.forEach(v=>add("verification",v.id,v.legalName));staff.forEach(v=>add("staff",v.id,v.name));orders.forEach(v=>{const snapshot=object(v.checkoutSnapshot);add("order",v.id,typeof snapshot.title==="string"?snapshot.title:typeof snapshot.eventTitle==="string"?snapshot.eventTitle:null);});
 payouts.forEach(v=>add("payout",v.id,v.reference));
 const relatedStaffNames=Object.fromEntries(staff.map(v=>[v.id,v.name]));
 return rows.map(row=>{
  const snapshot={...object(row.before),...object(row.after)},historical=snapshot.title??snapshot.legalName??snapshot.subject;
  return {...row,target:{type:row.targetType,id:row.targetId,name:names.get(`${row.targetType}:${row.targetId}`)??(typeof historical==="string"?historical:null),available:available.has(`${row.targetType}:${row.targetId}`),reference:row.targetType==="order"&&uuid.test(row.targetId)?`#${row.targetId.slice(-8).toUpperCase()}`:null},relatedStaffNames};
 });
}
