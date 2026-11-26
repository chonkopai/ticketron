import {z} from "zod";
import type {PublicEventSummary} from "./events.js";
export type HomepageAdEvent=Pick<PublicEventSummary,"id"|"title"|"posterUrl"|"media"|"date"|"time"|"startsAt"|"timezone"|"address"|"city"|"countryCode">;
export interface HomepageAdPlacement {eventId:string;position:number;eligible:boolean;event:HomepageAdEvent;}
export interface HomepageAdList {items:HomepageAdEvent[];}
export interface AdminHomepageAdList {items:HomepageAdPlacement[];}
export const homepageAdAddSchema=z.object({eventId:z.uuid()}).strict();
export const homepageAdMoveSchema=z.object({direction:z.enum(["up","down"])}).strict();
export function homepageAdEvent(event:HomepageAdEvent):HomepageAdEvent {
 const {id,title,posterUrl,media,date,time,startsAt,timezone,address,city,countryCode}=event;
 return {id,title,posterUrl,...(media?{media}:{}),date,time,startsAt,timezone,address,city,countryCode};
}
