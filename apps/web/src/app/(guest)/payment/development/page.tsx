import { ru } from "@event-platform/shared-types";
import Link from "next/link";

export default function DevelopmentPaymentPage() {
  return <main className="tk-status-page"><section className="tk-status-card"><span className="tk-status-ico is-wait" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 10h18M7 15h3"/></svg></span><h1>{ru.checkout.developmentTitle}</h1><p className="tk-status-text">{ru.checkout.developmentDescription}</p><div className="tk-status-actions"><Link className="tk-btn tk-btn-primary" href="/account">{ru.guest.profile}</Link></div></section></main>;
}
