"use client";

import type { ComponentProps } from "react";
import { AccountIcon } from "./account-icon";
import { SupportAttachments } from "./support-attachments";

export function MessageComposer({ value, onChange, label, sendLabel, sendingLabel, maxLength, ...attachments }: ComponentProps<typeof SupportAttachments> & {
  value: string;
  onChange: (value: string) => void;
  label: string;
  sendLabel: string;
  sendingLabel: string;
  maxLength: number;
}) {
  return <div className="message-composer" aria-busy={attachments.busy}>
    <textarea aria-label={label} placeholder={label} rows={1} maxLength={maxLength} required
      disabled={attachments.busy} value={value} onChange={event => onChange(event.target.value)} />
    <SupportAttachments {...attachments} compact />
    <button type="submit" className="message-send" disabled={attachments.busy || !value.trim()}
      aria-label={attachments.busy ? sendingLabel : sendLabel} title={sendLabel}>
      <AccountIcon name="send" />
    </button>
  </div>;
}
