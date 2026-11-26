import type { Prisma } from "@event-platform/database";
import { ConflictException } from "@nestjs/common";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export async function readPrivateUpload(directory: string, row: { name: string; mime: string; storageKey: string }) {
  return { name: row.name, mime: row.mime, buffer: await readFile(resolve(directory, row.storageKey)) };
}

export function sameFiles(files: { id: string }[], ids: string[]) {
  return files.length === ids.length && files.every(file => ids.includes(file.id));
}
export async function claimFiles(tx: Prisma.TransactionClient, ids: string[], data: Prisma.PrivateUploadUncheckedUpdateManyInput) {
  const claimed = await tx.privateUpload.updateMany({ where: { id: { in: ids }, messageId: null, chatMessageId: null, verificationId: null }, data });
  if (claimed.count !== ids.length) throw new ConflictException({ code: "ATTACHMENT_ALREADY_USED" });
}
