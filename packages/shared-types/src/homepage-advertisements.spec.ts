import {describe,it,expect} from "vitest";
import {homepageAdAddSchema,homepageAdMoveSchema,homepageAdEvent} from "./homepage-advertisements.js";
describe("homepage placement requests",()=>{
 it("accepts event IDs and only simple movement directions",()=>{
  expect(homepageAdAddSchema.parse({eventId:"10000000-0000-4000-8000-000000000001"})).toHaveProperty("eventId");
  expect(homepageAdAddSchema.safeParse({eventId:"invalid"}).success).toBe(false);
  expect(homepageAdAddSchema.safeParse({eventId:"10000000-0000-4000-8000-000000000001",position:99}).success).toBe(false);
  for(const direction of ["up","down"])expect(homepageAdMoveSchema.safeParse({direction}).success).toBe(true);
  expect(homepageAdMoveSchema.safeParse({direction:"publish"}).success).toBe(false);
 });
 it("keeps public advertisement data limited to existing event presentation fields",()=>{
  const event={id:"id",title:"Concert",posterUrl:null,date:"2035-01-01",time:"18:00",startsAt:"2035-01-01T18:00:00Z",timezone:"UTC",address:"Venue",city:"City",countryCode:"KZ",moderationReason:"private review",organizerId:"private-id"};
  expect(homepageAdEvent(event)).not.toHaveProperty("moderationReason");expect(homepageAdEvent(event)).not.toHaveProperty("organizerId");expect(homepageAdEvent(event).title).toBe("Concert");
 });
});
