import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { mergeMessages, SupportConversation } from "../components/platform-support";
import { SupportAttachments } from "../components/support-attachments";
import { LocaleProvider } from "../components/locale-provider";

test("polling merges fresh messages into loaded history without duplicating or discarding older messages", () => {
  const older = { id: "a", createdAt: "2026-11-15T10:00:00Z", text: "Older" };
  const current = { id: "b", createdAt: "2026-11-16T10:00:00Z", text: "Current" };
  const newer = { id: "c", createdAt: "2026-11-16T10:01:00Z", text: "New" };
  assert.deepEqual(mergeMessages([older, current], [newer, { ...current, text: "Updated" }]), [older, { ...current, text: "Updated" }, newer]);
});
for (const [locale, attach, remove] of [["ru", "Прикрепить файл", "Удалить"], ["kk", "Файл тіркеу", "Жою"], ["en", "Attach file", "Remove"]] as const) {
  test(`${locale} composer exposes attachments before history loads and labels selected file removal`, () => {
    const composer = renderToStaticMarkup(<LocaleProvider locale={locale}><SupportConversation id="test" /></LocaleProvider>);
    assert.match(composer, new RegExp(attach));
    assert.doesNotMatch(composer, /Ранее|Новее/);
    const selected = renderToStaticMarkup(<LocaleProvider locale={locale}><SupportAttachments files={[{ id: "f", name: "receipt.pdf", size: 1024, mime: "application/pdf" }]} onFiles={() => {}} upload={async () => { throw new Error("unused"); }} busy={false} onBusy={() => {}} onError={() => {}} /></LocaleProvider>);
    assert.match(selected, /receipt.pdf/);
    assert.match(selected, new RegExp(`aria-label="${remove} receipt.pdf"`));
    assert.match(selected, /1 KB/);
  });
}
