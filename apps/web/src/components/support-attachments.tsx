"use client";
import { useEffect, useRef, useState } from "react";
import type { PrivateFile } from "@event-platform/shared-types";
import { useSupportText } from "./platform-support";

export function SupportAttachments({ files, onFiles, upload, busy, onBusy, onError, compact = false }: {
  compact?: boolean;
  files: PrivateFile[]; onFiles: (files: PrivateFile[]) => void;
  upload: (file: File) => Promise<PrivateFile>; busy: boolean;
  onBusy: (busy: boolean) => void; onError: (message: string) => void;
}) {
  const t = useSupportText();
  const input = useRef<HTMLInputElement>(null), lock = useRef(false);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const urls = useRef<string[]>([]);
  useEffect(() => () => urls.current.forEach(url => URL.revokeObjectURL(url)), []);
  async function select(selected: FileList | null) {
    if (!selected?.length || lock.current || busy) return;
    lock.current = true; onBusy(true); onError("");
    let next = files;
    try {
      const list = Array.from(selected);
      if (files.length + list.length > 5) throw new Error(t("Максимум 5 файлов", "Ең көбі 5 файл", "Maximum 5 files"));
      for (const file of list) {
        if (!/\.(pdf|jpe?g|png)$/i.test(file.name) || !["application/pdf", "image/jpeg", "image/png"].includes(file.type))
          throw new Error(t("Выберите PDF, JPEG или PNG", "PDF, JPEG немесе PNG таңдаңыз", "Choose PDF, JPEG or PNG"));
        if (file.size > 10 * 1024 * 1024 || !file.size) throw new Error(t("Размер файла должен быть до 10 МБ", "Файл 10 МБ дейін болуы керек", "Files must be up to 10 MB"));
      }
      for (const file of list) {
        const saved = await upload(file);
        next = [...next, saved]; onFiles(next);
        if (file.type.startsWith("image/")) {
          const url = URL.createObjectURL(file); urls.current.push(url);
          setPreviews(previous => ({ ...previous, [saved.id]: url }));
        }
      }
    } catch (e) { onError((e as Error).message); }
    finally { lock.current = false; onBusy(false); }
  }
  const attachmentLabel = t("Прикрепить файл", "Файл тіркеу", "Attach file");
  const limits = t("PDF, JPEG, PNG · до 10 МБ · до 5 файлов", "PDF, JPEG, PNG · 10 МБ дейін · 5 файл", "PDF, JPEG, PNG · up to 10 MB · 5 files");
  return <div className={`support-attachments${compact ? " is-compact" : ""}`}>
    <input ref={input} hidden type="file" accept=".pdf,.jpg,.jpeg,.png" multiple disabled={busy || files.length >= 5}
      onChange={e => { void select(e.target.files); e.target.value = ""; }} />
    <button type="button" className="support-attach-button" aria-label={attachmentLabel} title={compact ? `${attachmentLabel} · ${limits}` : undefined} disabled={busy || files.length >= 5} onClick={() => input.current?.click()}>
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="m8 13 7-7a3 3 0 0 1 4 4l-9 9a5 5 0 0 1-7-7l9-9a1 1 0 0 1 7 7l-8 8a1 1 0 0 1-4-4l7-7"/></svg>
      {compact ? null : attachmentLabel}
    </button>
    {compact ? null : <small>{limits}</small>}
    {files.length ? <ul className="support-file-list">{files.map(file => <li className="support-file-card" key={file.id}>
      {previews[file.id] ? <img src={previews[file.id]} alt="" width={48} height={48} loading="lazy" decoding="async" /> : <span aria-hidden="true">{file.mime === "application/pdf" ? "PDF" : "▧"}</span>}
      <span>{file.name}<small>{Math.ceil(file.size / 1024)} KB</small></span>
      <button type="button" disabled={busy} aria-label={`${t("Удалить", "Жою", "Remove")} ${file.name}`} onClick={() => onFiles(files.filter(f => f.id !== file.id))}>×</button>
    </li>)}</ul> : null}
  </div>;
}
