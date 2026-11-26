import "../test-support/require-test-database.js";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { prisma } from "@event-platform/database";
import { afterAll, describe, expect, it } from "vitest";

import { PlatformSupportService } from "./platform-support.service.js";

describe("unattached support upload cleanup", () => {
  it("removes old unattached uploads with their files and keeps recent or attached ones", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uploads-"));
    const service = new PlatformSupportService(prisma, { storageDir: dir } as never, {} as never);
    const ids: string[] = [];
    let caseId: string | undefined;
    let owner: { id: string } | undefined;
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const make = async (createdAt: Date, extra: Record<string, unknown> = {}, withFile = true) => {
      const id = randomUUID();
      ids.push(id);
      const storageKey = `${id}.pdf`;
      if (withFile) await writeFile(join(dir, storageKey), "x");
      await prisma.privateUpload.create({ data: { id, name: "a.pdf", mime: "application/pdf", size: 1, storageKey, createdAt, ownerId: owner!.id, ...extra } });
      return { id, path: join(dir, storageKey) };
    };
    try {
      owner = await prisma.user.create({ data: { role: "guest" } });
      const supportCase = await prisma.platformCase.create({ data: { subject: "Upload cleanup", ownerId: owner.id } });
      caseId = supportCase.id;
      const message = await prisma.platformMessage.create({ data: { caseId, clientKey: randomUUID(), authorKind: "customer", text: "hi" } });
      const stale = await make(old, {}, true);
      const missingFile = await make(old, {}, false);
      const recent = await make(new Date());
      const attached = await make(old, { messageId: message.id });
      await service.pruneUnattachedUploads();
      const left = new Set((await prisma.privateUpload.findMany({ where: { id: { in: ids } } })).map((r) => r.id));
      expect(left.has(stale.id)).toBe(false);
      expect(left.has(missingFile.id)).toBe(false);
      expect(existsSync(stale.path)).toBe(false);
      expect(left.has(recent.id) && existsSync(recent.path)).toBe(true);
      expect(left.has(attached.id) && existsSync(attached.path)).toBe(true);
    } finally {
      await prisma.privateUpload.deleteMany({ where: { id: { in: ids } } });
      if (caseId) {
        await prisma.platformMessage.deleteMany({ where: { caseId } });
        await prisma.platformCase.delete({ where: { id: caseId } });
      }
      if (owner) await prisma.user.delete({ where: { id: owner.id } }).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });
});
afterAll(() => prisma.$disconnect());
