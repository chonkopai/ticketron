import type { EventLocale } from "@event-platform/shared-types";

interface AuthCopy {
  sentAgain: string; sent: string; verified: string; resetDone: string;
  registerTitle: string; resetTitle: string; loginTitle: string;
  loginSubtitle: string; registerSubtitle: string; resetSubtitle: string;
  codeSubtitle: string; registerDetailsSubtitle: string; resetDetailsSubtitle: string;
  emailAddress: string; phoneNumber: string; usePhone: string; useEmail: string;
  authRegion: string; catalog: string; backToCatalog: string; language: string;
  methods: string; or: string; telegramTitle: string; telegramHint: string;
  telegramClose: string; telegramReturn: string;
  actionLabel: string; login: string; register: string; forgot: string; backToLogin: string;
  smsUnavailable: string; smsSoon: string; verifiedAddress: string; codeSentTo: string;
  change: string; mailCode: string; resendIn: string; resend: string;
  firstName: string; lastName: string; wait: string; legal: string;
  soon: string; newPassword: string; password: string; hidePassword: string;
  showPassword: string; passwordPlaceholder: string; newPasswordPlaceholder: string;
  passwordMinimum: string; submitLogin: string; submitResetCode: string;
  submitCode: string; submitConfirm: string; submitRegister: string; submitPassword: string;
  requestFailed: string;
}

export const AUTH_COPY: Record<EventLocale, AuthCopy> = {
  ru: {
    sentAgain: "Новый код отправлен. Предыдущий код больше не действует.", sent: "Если адрес доступен, код отправлен. Проверьте почту.",
    verified: "Контакт подтверждён. Завершите настройку.", resetDone: "Пароль обновлён. Войдите с новым паролем.",
    registerTitle: "Создайте аккаунт", resetTitle: "Восстановление доступа", loginTitle: "Вход в TICKET",
    loginSubtitle: "Ваши билеты, заказы и события — в одном аккаунте.",
    registerSubtitle: "Билеты, история заказов и уведомления в Telegram.",
    resetSubtitle: "Мы отправим код, чтобы вы могли задать новый пароль.",
    codeSubtitle: "Введите 6-значный код, который мы вам отправили.",
    registerDetailsSubtitle: "Почти готово — осталось имя и пароль.", resetDetailsSubtitle: "Придумайте новый пароль.",
    emailAddress: "Email", phoneNumber: "Телефон", usePhone: "Использовать телефон", useEmail: "Использовать email",
    authRegion: "Вход и регистрация", catalog: "TICKET — афиша", backToCatalog: "В афишу", language: "Язык",
    methods: "Способы входа", or: "или", telegramTitle: "Войти через Telegram",
    telegramHint: "Продолжите вход в безопасном окне Telegram.", telegramClose: "Закрыть вход через Telegram",
    telegramReturn: "Вернуться к Email или телефону",
    actionLabel: "Действие", login: "Вход", register: "Регистрация", forgot: "Забыли пароль?", backToLogin: "Вернуться ко входу",
    smsUnavailable: "Подтверждение по SMS пока недоступно. Используйте Email или Telegram.", smsSoon: "SMS-код скоро",
    verifiedAddress: "Подтверждённый адрес", codeSentTo: "Код отправлен на", change: "Изменить",
    mailCode: "Код из письма", resendIn: "Повторить через", resend: "Отправить ещё раз",
    firstName: "Имя", lastName: "Фамилия", wait: "Подождите…",
    legal: "Используйте проверенные способы входа в аккаунт TICKET. Контактные данные нужны для защиты доступа к билетам.",
    soon: "Скоро", newPassword: "Новый пароль", password: "Пароль", hidePassword: "Скрыть пароль",
    showPassword: "Показать пароль", passwordPlaceholder: "Введите пароль", newPasswordPlaceholder: "Придумайте пароль",
    passwordMinimum: "Не менее 12 символов.", submitLogin: "Войти", submitResetCode: "Получить код доступа",
    submitCode: "Получить код", submitConfirm: "Подтвердить", submitRegister: "Создать аккаунт",
    submitPassword: "Сохранить пароль", requestFailed: "Не удалось выполнить запрос.",
  },
  kk: {
    sentAgain: "Жаңа код жіберілді. Алдыңғы код енді жарамсыз.", sent: "Мекенжай қолжетімді болса, код жіберілді. Поштаңызды тексеріңіз.",
    verified: "Байланыс расталды. Тіркеуді аяқтаңыз.", resetDone: "Құпиясөз жаңартылды. Жаңа құпиясөзбен кіріңіз.",
    registerTitle: "Аккаунт ашыңыз", resetTitle: "Қолжетімділікті қалпына келтіру", loginTitle: "TICKET-ке кіру",
    loginSubtitle: "Билеттеріңіз, тапсырыстарыңыз және іс-шараларыңыз — бір аккаунтта.",
    registerSubtitle: "Билеттер, тапсырыстар тарихы және Telegram-дағы хабарламалар.",
    resetSubtitle: "Жаңа құпиясөз орнату үшін сізге код жібереміз.",
    codeSubtitle: "Біз жіберген 6 таңбалы кодты енгізіңіз.",
    registerDetailsSubtitle: "Аз қалды — атыңыз бен құпиясөз.", resetDetailsSubtitle: "Жаңа құпиясөз ойлап табыңыз.",
    emailAddress: "Email", phoneNumber: "Телефон", usePhone: "Телефонды пайдалану", useEmail: "Email пайдалану",
    authRegion: "Кіру және тіркелу", catalog: "TICKET — афиша", backToCatalog: "Афишаға", language: "Тіл",
    methods: "Кіру тәсілдері", or: "немесе", telegramTitle: "Telegram арқылы кіру",
    telegramHint: "Telegram-ның қауіпсіз терезесінде кіруді жалғастырыңыз.", telegramClose: "Telegram арқылы кіруді жабу",
    telegramReturn: "Email немесе телефонға оралу",
    actionLabel: "Әрекет", login: "Кіру", register: "Тіркелу", forgot: "Құпиясөзді ұмыттыңыз ба?", backToLogin: "Кіру бетіне оралу",
    smsUnavailable: "SMS арқылы растау әзірге қолжетімсіз. Email немесе Telegram пайдаланыңыз.", smsSoon: "SMS-код жақында",
    verifiedAddress: "Расталған мекенжай", codeSentTo: "Код жіберілген мекенжай", change: "Өзгерту",
    mailCode: "Хаттағы код", resendIn: "Қайта жіберу", resend: "Қайта жіберу",
    firstName: "Аты", lastName: "Тегі", wait: "Күте тұрыңыз…",
    legal: "TICKET аккаунтына кірудің тексерілген тәсілдерін пайдаланыңыз. Байланыс деректері билеттеріңізге қолжетімділікті қорғау үшін қажет.",
    soon: "Жақында", newPassword: "Жаңа құпиясөз", password: "Құпиясөз", hidePassword: "Құпиясөзді жасыру",
    showPassword: "Құпиясөзді көрсету", passwordPlaceholder: "Құпиясөзді енгізіңіз", newPasswordPlaceholder: "Құпиясөз ойлап табыңыз",
    passwordMinimum: "Кемінде 12 таңба.", submitLogin: "Кіру", submitResetCode: "Қалпына келтіру кодын алу",
    submitCode: "Код алу", submitConfirm: "Растау", submitRegister: "Аккаунт ашу",
    submitPassword: "Құпиясөзді сақтау", requestFailed: "Сұрауды орындау мүмкін болмады.",
  },
  en: {
    sentAgain: "A new code was sent. The previous code no longer works.", sent: "If the address is available, a code was sent. Check your email.",
    verified: "Contact verified. Finish setting up your account.", resetDone: "Password updated. Sign in with your new password.",
    registerTitle: "Create your account", resetTitle: "Recover your account", loginTitle: "Sign in to TICKET",
    loginSubtitle: "Your tickets, orders and events — in one account.",
    registerSubtitle: "Tickets, order history and Telegram notifications.",
    resetSubtitle: "We'll send a code so you can set a new password.",
    codeSubtitle: "Enter the 6-digit code we sent you.",
    registerDetailsSubtitle: "Almost done — just your name and a password.", resetDetailsSubtitle: "Choose a new password.",
    emailAddress: "Email", phoneNumber: "Phone", usePhone: "Use phone", useEmail: "Use email",
    authRegion: "Sign in and sign up", catalog: "TICKET — events", backToCatalog: "Events", language: "Language",
    methods: "Sign-in methods", or: "or", telegramTitle: "Sign in with Telegram",
    telegramHint: "Continue in Telegram's secure window.", telegramClose: "Close Telegram sign-in",
    telegramReturn: "Return to email or phone",
    actionLabel: "Action", login: "Sign in", register: "Sign up", forgot: "Forgot password?", backToLogin: "Back to sign in",
    smsUnavailable: "SMS verification is not available yet. Use email or Telegram.", smsSoon: "SMS code coming soon",
    verifiedAddress: "Verified address", codeSentTo: "Code sent to", change: "Change",
    mailCode: "Code from email", resendIn: "Resend in", resend: "Send another code",
    firstName: "First name", lastName: "Last name", wait: "Please wait…",
    legal: "Use a verified sign-in method for your TICKET account. Contact details help protect access to your tickets.",
    soon: "Soon", newPassword: "New password", password: "Password", hidePassword: "Hide password",
    showPassword: "Show password", passwordPlaceholder: "Enter password", newPasswordPlaceholder: "Create a password",
    passwordMinimum: "At least 12 characters.", submitLogin: "Sign in", submitResetCode: "Get recovery code",
    submitCode: "Get code", submitConfirm: "Confirm", submitRegister: "Create account",
    submitPassword: "Save password", requestFailed: "Request failed.",
  },
};
