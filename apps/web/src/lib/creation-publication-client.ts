import { EVENT_LOCALES, draftLocaleFields, type CreationDraftResponse, type CreationPublication, type CreationPublishIntent, type DraftTranslationResult, type EventLocale } from "@event-platform/shared-types";
import { creationDraftRequest,finishPublishedDraft,type DraftAutosave } from "./creation-draft-client";
import { getSession,updateSessionUser } from "../app/(auth)/_lib/session";
const resumes=new Map<string,Promise<CreationPublication>>();
export function creationContinuation(id:string,intentId:string,locale:EventLocale,contentLocale:EventLocale){return `/events/create/continue?draftId=${encodeURIComponent(id)}&intentId=${encodeURIComponent(intentId)}&lang=${locale}&contentLocale=${contentLocale}`;}
export function publicationDestination(locale:EventLocale){return `/organizer/events?published=1&lang=${locale}`;}
export async function fillMissingEventTranslations(client: DraftAutosave) {
  const { id, aggregate } = await client.flush();
  const source = aggregate.sourceLocale;
  const sourceFields = draftLocaleFields(aggregate, source).filter(field => field.text.trim());
  for (const target of EVENT_LOCALES) {
    if (target === source) continue;
    const targetFields = new Map(draftLocaleFields(client.aggregate, target).map(field => [field.key, field.text]));
    const missing = sourceFields.some(field => {
      const metadata = client.aggregate.metadata[target]?.[field.key];
      return !targetFields.get(field.key)?.trim() || (metadata?.origin === "machine" && metadata.stale);
    });
    if (!missing) continue;
    try {
      await client.translationMutation(saved => creationDraftRequest<DraftTranslationResult>(`/api/creation-drafts/${id}/translations`, {
        method: "POST", headers: { "content-type": "application/json", "x-draft-csrf": saved.csrfToken },
        body: JSON.stringify({ revision: saved.revision, targetLocale: target, onlyMissing: true }),
      }));
    } catch (error) {
      // Publication can still use the source language if the translation provider is unavailable.
      if (client.dirty || (error instanceof Error && /REVISION|DRAFT_NOT_FOUND|DRAFT_EXPIRED/.test(error.message))) throw error;
      client.adopt(client.saved);
      if (error instanceof Error && error.message === "TRANSLATION_NOT_CONFIGURED") return;
    }
  }
}
export async function preparePublication(client:DraftAutosave){const saved=await client.flush();const intent=await creationDraftRequest<CreationPublishIntent>(`/api/creation-drafts/${saved.id}/publish-intent`,{method:"POST",headers:{"content-type":"application/json","x-draft-csrf":saved.csrfToken},body:JSON.stringify({revision:saved.revision})});if(client.dirty||client.saved.revision!==intent.revision)throw new Error("PUBLISH_INTENT_STALE");return intent;}
export async function publishIntent(draft:CreationDraftResponse,intentId:string){const result=await creationDraftRequest<CreationPublication>(`/api/creation-drafts/${draft.id}/publish`,{method:"POST",headers:{"content-type":"application/json","x-draft-csrf":draft.csrfToken},body:JSON.stringify({intentId})});updateSessionUser(result.user);finishPublishedDraft(draft.id);return result;}
export function resumePublication(id:string,intentId:string){const key=`${id}:${intentId}:${getSession()?.user.id??"anonymous"}`;const pending=resumes.get(key);if(pending)return pending;const promise=(async()=>{const draft=await creationDraftRequest<CreationDraftResponse>(`/api/creation-drafts/${id}`);await creationDraftRequest<CreationPublishIntent>(`/api/creation-drafts/${id}/publish-intents/${intentId}`);return publishIntent(draft,intentId);})();resumes.set(key,promise);promise.catch(()=>resumes.delete(key));return promise;}
