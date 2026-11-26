import { formatMoney } from "@event-platform/shared-types";
import type { EventLocale } from "@event-platform/shared-types";
type RecordValue=Record<string,unknown>;
export const auditObject=(value:unknown):RecordValue=>value!==null&&typeof value==="object"&&!Array.isArray(value)?value as RecordValue:{};
const labels:Record<string,[string,string,string]>={
 "homepage_ad.added":["Добавил мероприятие в рекламу на главной","Іс-шараны басты бет жарнамасына қосты","Added an event to homepage advertising"],
 "homepage_ad.removed":["Убрал мероприятие из рекламы на главной","Іс-шараны басты бет жарнамасынан алды","Removed an event from homepage advertising"],
 "homepage_ad.reordered":["Изменил порядок рекламы на главной","Басты бет жарнамасының ретін өзгертті","Reordered homepage advertising"],
 "support.reply":["Ответил на обращение","Өтінішке жауап берді","Replied to an enquiry"],
 "support.note":["Добавил внутреннюю заметку","Ішкі жазба қосты","Added an internal note"],
 "support.updated":["Обновил обращение","Өтінішті жаңартты","Updated an enquiry"],
 "support.order_chat_viewed":["Открыл переписку по заказу","Тапсырыс хаттарын ашты","Viewed an order conversation"],
 "private_file.viewed":["Просмотрел защищённое вложение","Қорғалған тіркемені қарады","Viewed a protected attachment"],
 "staff.login_failed":["Неудачная попытка входа","Кіру әрекеті сәтсіз аяқталды","Sign-in attempt failed"],
 "staff.invite_accepted":["Принял приглашение сотрудника","Қызметкер шақыруын қабылдады","Accepted a staff invitation"],
 "staff.reset_accepted":["Восстановил доступ сотрудника","Қызметкер қолжетімділігін қалпына келтірді","Recovered staff access"],
 "staff.mfa_login":["Вошёл в админ-панель","Әкімші панеліне кірді","Signed in to admin"],
 "staff.mfa_enrolled":["Подключил двухэтапную проверку","Екі сатылы тексеруді қосты","Enabled two-step verification"],
 "staff.mfa_reset":["Сбросил двухэтапную проверку","Екі сатылы тексеруді қалпына келтірді","Reset two-step verification"],
 "staff.session_revoked":["Завершил сеанс сотрудника","Қызметкер сеансын аяқтады","Revoked a staff session"],
 "staff.invited":["Пригласил сотрудника","Қызметкерді шақырды","Invited a staff member"],
 "staff.changed":["Изменил доступ сотрудника","Қызметкер қолжетімділігін өзгертті","Changed staff access"],
 "staff.bootstrapped":["Создал первоначальный доступ администратора","Бастапқы әкімші қолжетімділігін жасады","Created initial admin access"],
 "verification.reviewed":["Обновил решение по заявке организатора","Ұйымдастырушы өтінішінің шешімін жаңартты","Updated an organizer application decision"],
 "event.approve":["Одобрил мероприятие","Іс-шараны мақұлдады","Approved an event"],
 "event.reject":["Отклонил мероприятие","Іс-шараны қабылдамады","Rejected an event"],
 "event.hide":["Скрыл мероприятие","Іс-шараны жасырды","Hid an event"],
 "event.unhide":["Вернул мероприятие на сайт","Іс-шараны сайтқа қайтарды","Made an event visible again"],
 "event.pause":["Остановил продажи","Сатылымды тоқтатты","Paused sales"],
 "event.resume":["Возобновил продажи","Сатылымды жалғастырды","Resumed sales"],
 "event.cancel":["Отменил мероприятие","Іс-шараны болдырмады","Cancelled an event"],
 "event.cancelled":["Отменил мероприятие","Іс-шараны болдырмады","Cancelled an event"],
 "order.cancelled":["Отменил заказ","Тапсырысты болдырмады","Cancelled an order"],
 "organizer.warning":["Добавил замечание организатору","Ұйымдастырушыға ескерту қосты","Recorded an organizer warning"],
 "user.blocked":["Заблокировал пользователя","Пайдаланушыны бұғаттады","Blocked a user"],
 "user.unblocked":["Разблокировал пользователя","Пайдаланушыны бұғаттан шығарды","Unblocked a user"],
 "commission.changed":["Изменил комиссию","Комиссияны өзгертті","Changed commission"],
 "finance.exported":["Выгрузил финансовый отчёт","Қаржы есебін жүктеп алды","Exported a finance report"],
 "payout.recorded":["Записал выплату","Төлемді тіркеді","Recorded a payout"],
 "payout.reversed":["Сторнировал запись о выплате","Төлем жазбасын кері қайтарды","Reversed a payout record"],
 "refund.requested":["Запросил возврат","Қайтаруды сұрады","Requested a refund"],
 "refund.failed":["Зафиксировал неудачный возврат","Сәтсіз қайтаруды тіркеді","Recorded a failed refund"],
 "refund.succeeded":["Подтвердил возврат","Қайтаруды растады","Confirmed a refund"],
 "ticket.resend":["Повторно отправил билет","Билетті қайта жіберді","Resent a ticket"],
 "ticket.resend_requested":["Запросил повторную отправку билета","Билетті қайта жіберуді сұрады","Requested ticket redelivery"],
 "ticket.resend_queued":["Поставил повторную отправку билета в очередь","Билетті қайта жіберуді кезекке қойды","Queued ticket redelivery"],
 "ticket.resend_failed":["Зафиксировал ошибку отправки билета","Билетті жіберу қатесін тіркеді","Recorded a ticket delivery failure"],
};
const index=(locale:EventLocale)=>locale==="ru"?0:locale==="kk"?1:2;
export function auditAction(row:RecordValue,locale:EventLocale):string {
 const i=index(locale),before=auditObject(row.before),after=auditObject(row.after);
 if(row.action==="verification.reviewed") {
  const decisions:Record<string,[string,string,string]>={verified:["Подтвердил организатора","Ұйымдастырушыны растады","Verified an organizer"],rejected:["Отклонил заявку организатора","Ұйымдастырушы өтінішін қабылдамады","Rejected an organizer application"],changes_requested:["Запросил уточнение данных организатора","Ұйымдастырушы деректерін нақтылауды сұрады","Requested updated organizer details"],revoked:["Отозвал статус проверенного организатора","Расталған ұйымдастырушы мәртебесін қайтарды","Revoked organizer verification"]};
  if(typeof after.status==="string"&&decisions[after.status]) return decisions[after.status]![i];
 }
 if(row.action==="support.updated") {
  const changes:string[]=[];
  if(Object.hasOwn(before,"assignedStaffId")&&Object.hasOwn(after,"assignedStaffId")&&before.assignedStaffId!==after.assignedStaffId) {
   changes.push((after.assignedStaffId===row.staffId&&row.staffId ? ["Назначил обращение себе","Өтінішті өзіне тағайындады","Assigned an enquiry to themselves"] : after.assignedStaffId===null ? ["Снял назначение обращения","Өтініш тағайындауын алып тастады","Unassigned an enquiry"] : ["Изменил ответственного за обращение","Өтініш жауаптысын өзгертті","Changed the enquiry assignee"])[i]!);
  }
  if(Object.hasOwn(before,"status")&&Object.hasOwn(after,"status")&&before.status!==after.status) changes.push(["Изменил статус обращения","Өтініш күйін өзгертті","Changed the enquiry status"][i]!);
  if(changes.length) return changes.join(" · ");
 }
 return labels[String(row.action)]?.[i] ?? ["Выполнил действие (историческая запись)","Әрекет орындалды (тарихи жазба)","Performed an action (historical record)"][i]!;
}
export function auditTargetLabel(type:unknown,locale:EventLocale):string {
 const names:Record<string,[string,string,string]>={event:["Мероприятие","Іс-шара","Event"],case:["Обращение","Өтініш","Enquiry"],verification:["Заявка организатора","Ұйымдастырушы өтініші","Organizer application"],user:["Пользователь","Пайдаланушы","User"],staff:["Сотрудник","Қызметкер","Staff member"],order:["Заказ","Тапсырыс","Order"],refund:["Возврат","Қайтару","Refund"],payout:["Выплата","Төлем","Payout"],setting:["Настройки комиссии","Комиссия баптаулары","Commission settings"],finance:["Финансовый отчёт","Қаржы есебі","Finance report"]};
 return names[String(type)]?.[index(locale)] ?? ["Запись","Жазба","Record"][index(locale)]!;
}
const fields:Record<string,[string,string,string]>={position:["Место в рекламе","Жарнамадағы орны","Advertisement position"],selected:["Выбрано для рекламы","Жарнамаға таңдалған","Selected for advertising"],status:["Статус","Күйі","Status"],assignedStaffId:["Ответственный","Жауапты","Assignee"],role:["Уровень доступа","Қолжетімділік деңгейі","Access level"],blocked:["Пользователь заблокирован","Пайдаланушы бұғатталған","User blocked"],exceptional:["Исключение из правил возврата","Қайтару ережесінен ерекшелік","Refund policy exception"],disabled:["Доступ отключён","Қолжетімділік өшірілген","Access disabled"],moderationStatus:["Модерация","Модерация","Moderation"],notify:["Уведомить покупателей","Сатып алушыларға хабарлау","Notify buyers"],title:["Название мероприятия","Іс-шара атауы","Event name"],legalName:["Юридическое имя","Заңды атауы","Legal name"],subject:["Тема обращения","Өтініш тақырыбы","Enquiry subject"],blockedAt:["Дата блокировки","Бұғаттау күні","Blocked at"],basisPoints:["Комиссия","Комиссия","Commission"],commissionBps:["Комиссия","Комиссия","Commission"],amount:["Сумма","Сома","Amount"],reference:["Номер / назначение выплаты","Төлем нөмірі / мақсаты","Payout reference"],paidAt:["Дата выплаты","Төлем күні","Paid at"],testOnly:["Тестовая запись","Сынақ жазбасы","Test record"],reversedAt:["Дата сторнирования","Кері қайтару күні","Reversed at"],currency:["Валюта","Валюта","Currency"]};
export function auditChanges(row:RecordValue,locale:EventLocale) {
 const before=auditObject(row.before),after=auditObject(row.after),names=auditObject(row.relatedStaffNames),i=index(locale);
 const value=(input:unknown,key:string):string=>{
  if(input===null||input===undefined) return ["Не указано","Көрсетілмеген","Not specified"][i]!;
  if(typeof input==="boolean") return (input?["Да","Иә","Yes"]:["Нет","Жоқ","No"])[i]!;
  if(key==="position"&&typeof input==="number") return String(input+1);
  if(key==="assignedStaffId") return typeof names[String(input)]==="string"?String(names[String(input)]):auditTargetLabel("staff",locale);
  if((key==="commissionBps"||key==="basisPoints")&&typeof input==="number") return `${input/100}%`;
  if(key==="status"||key==="moderationStatus"||key==="role") {
   const states:Record<string,[string,string,string]>={paid:["Оплачено","Төленген","Paid"],requested:["Запрошено","Сұралған","Requested"],processing:["Обрабатывается","Өңделуде","Processing"],succeeded:["Подтверждено","Расталған","Confirmed"],failed:["Не выполнено","Орындалмаған","Failed"],new:["Новое","Жаңа","New"],in_progress:["В работе","Жұмыста","In progress"],closed:["Закрыто","Жабық","Closed"],pending:["На проверке","Тексеруде","Pending review"],verified:["Проверенный организатор","Расталған ұйымдастырушы","Verified organizer"],rejected:["Отклонено","Қабылданбаған","Rejected"],changes_requested:["Нужно уточнить данные","Деректерді нақтылау қажет","Changes requested"],revoked:["Проверка отозвана","Растау қайтарылған","Verification revoked"],published:["Опубликовано","Жарияланған","Published"],draft:["Черновик","Нобай","Draft"],cancelled:["Отменено","Болдырылмаған","Cancelled"],completed:["Завершено","Аяқталған","Completed"],approved:["Одобрено","Мақұлданған","Approved"],sales_paused:["Продажи остановлены","Сатылым тоқтатылған","Sales paused"],hidden:["Скрыто","Жасырылған","Hidden"],clear:["Не отправлено на проверку","Тексеруге жіберілмеген","Not submitted for review"],support:["Поддержка","Қолдау","Support"],moderator:["Модератор","Модератор","Moderator"]};
   return states[String(input)]?.[i] ?? ["Другое значение (см. технические данные)","Басқа мән (техникалық деректерді қараңыз)","Other value (see technical data)"][i]!;
  }
  if(key==="amount"&&typeof input==="number") {
   const currency=after.currency??before.currency;
   if(typeof currency==="string"&&/^[A-Z]{3}$/.test(currency.trim())) return formatMoney(input, currency.trim(), ({ru:"ru-RU",kk:"kk-KZ",en:"en-US"})[locale]);
  }
  if(key.endsWith("At")&&typeof input==="string"&&!Number.isNaN(Date.parse(input))) return new Intl.DateTimeFormat(({ru:"ru-RU",kk:"kk-KZ",en:"en-US"})[locale],{dateStyle:"medium",timeStyle:"short"}).format(new Date(input));
  if(typeof input==="string"||typeof input==="number") return String(input);
  return ["См. технические данные","Техникалық деректерді қараңыз","See technical data"][i]!;
 };
 return [...new Set([...Object.keys(before),...Object.keys(after)])].filter(key=>fields[key]&&JSON.stringify(before[key])!==JSON.stringify(after[key])).map(key=>({key,label:fields[key]![i],before:value(before[key],key),after:value(after[key],key)}));
}
