"use client";
import type { EventLocale } from "@event-platform/shared-types";
const words={ru:{none:"Возврат денежных средств не предусмотрен.",free:"Бесплатную регистрацию можно отменить без денежного возврата."},en:{none:"Monetary refunds are not available.",free:"Free registrations can be cancelled without a monetary refund."},kk:{none:"Ақшалай қайтарым қарастырылмаған.",free:"Тегін тіркелуді ақшалай қайтарымсыз тоқтатуға болады."}};

export function RefundPolicyText({locale,free,available,conditions}:{locale:EventLocale;free:boolean;available:boolean;conditions:string|null}){const c=words[locale];return <p className="whitespace-pre-wrap text-sm">{free?c.free:available?conditions:c.none}</p>;}
