import {describe,it,expect} from "vitest";
import {decisionSchema} from "./administration.js";
import {verificationReadiness,verificationDecisionNotice} from "./organizer-verification.js";
const row={legalName:"Example Organizer",entityType:"ip",countryCode:"KZ",registrationId:"123",email:"owner@example.test",phone:"+77001234567",documents:[{id:"10000000-0000-4000-8000-000000000001",name:"registration.pdf",size:123,mime:"application/pdf"}]};
describe("organizer readiness and decisions",()=>{
 it("distinguishes complete fields from the awarded verification status",()=>{expect(verificationReadiness(row)).toEqual({readyForReview:true,missingFields:[]});expect(verificationReadiness({...row,documents:[]})).toEqual({readyForReview:false,missingFields:["fileIds"]});expect(verificationReadiness({...row,entityType:"other"}).missingFields).toContain("entityTypeDetails");});
 it("accepts omitted and blank reasons, rejects oversized and unsupported decisions",()=>{expect(decisionSchema.parse({decision:"verified"}).reason).toBe("");expect(decisionSchema.parse({decision:"rejected",reason:"  "}).reason).toBe("");expect(decisionSchema.safeParse({decision:"verified",reason:"x".repeat(501)}).success).toBe(false);expect(decisionSchema.safeParse({decision:"approved"}).success).toBe(false);});
 it("localizes decisions and includes only supplied reasons",()=>{expect(verificationDecisionNotice("Company","verified",null,"ru")).toBe("«Company»: организатор подтверждён.");expect(verificationDecisionNotice("Company","rejected","Update documents","en")).toContain("Reason: Update documents");expect(verificationDecisionNotice("Company","verified","","kk")).toContain("ұйымдастырушы расталды");});
});
