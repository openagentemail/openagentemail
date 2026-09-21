/**
 * OAuth 同意页 / 授权交接页文案（#137 B2）。
 * 随会话 locale 归一（卡 §5 裁点 3 a 案）；不进控制台 I18N_EN 键集（oauth 服务端独立渲染）。
 */
import type { UiLocale } from './resolve-ui-locale.ts';

export type OAuthCopy = {
  brandSuffix: string;
  handoffTitle: string;
  handoffH1: string;
  handoffMuted: string;
  handoffLink: string;
  authorizeTitle: string;
  authorizeH1: string;
  wantsAccess: string; // 前缀：{client} wants…；用 tFormat 式拼接
  wantsAccessAfter: string;
  metaClient: string;
  metaClientIdHost: string;
  metaRedirectHost: string;
  metaClientId: string;
  loopbackWarnBefore: string;
  loopbackWarnAfter: string;
  linkLoginNotice: string;
  chooseIdentity: string;
  existingIdentity: string;
  createIdentity: string;
  localpartPlaceholder: string;
  approve: string;
  deny: string;
  forbiddenTitle: string;
  forbiddenH1: string;
  forbiddenBody: string;
  backToInbox: string;
  authErrorTitle: string;
  authErrorH1: string;
  malformedBody: string;
  invalidFormFieldTypes: string;
  invalidLocalpart: string;
  addressTaken: string;
  notifyProvisionFailed: string;
  provisionFailed: string;
  unknownIdentity: string;
};

const EN: OAuthCopy = {
  brandSuffix: 'OpenAgent.email',
  handoffTitle: 'Authorized',
  handoffH1: 'Authorized — returning to the client',
  handoffMuted: 'If you are not redirected automatically, use the link below.',
  handoffLink: 'Return to client',
  authorizeTitle: 'Authorize',
  authorizeH1: 'Authorize application',
  wantsAccess: ' wants access to an OpenAgent identity via MCP.',
  wantsAccessAfter: '',
  metaClient: 'Client',
  metaClientIdHost: 'Client ID host',
  metaRedirectHost: 'Redirect host',
  metaClientId: 'Client ID',
  loopbackWarnBefore: 'This client redirects to a loopback address (',
  loopbackWarnAfter: '). Only continue if you started this authorization yourself.',
  linkLoginNotice: 'Signed in via link as Admin session',
  chooseIdentity: 'Choose identity',
  existingIdentity: 'Existing identity',
  createIdentity: 'Create a new identity',
  localpartPlaceholder: 'localpart',
  approve: 'Approve',
  deny: 'Deny',
  forbiddenTitle: 'Forbidden',
  forbiddenH1: 'Admin session required',
  forbiddenBody: 'OAuth consent is owner-only. Sign in with an admin API token.',
  backToInbox: '← Back to inbox',
  authErrorTitle: 'Authorization error',
  authErrorH1: 'Authorization error',
  malformedBody: 'Malformed body.',
  invalidFormFieldTypes: 'Invalid form field types.',
  invalidLocalpart: 'Invalid localpart.',
  addressTaken: 'That address is already taken.',
  notifyProvisionFailed: 'Notification provisioning failed; identity was not created.',
  provisionFailed: 'Failed to provision identity.',
  unknownIdentity: 'Unknown identity.',
};

const ES: OAuthCopy = {
  brandSuffix: 'OpenAgent.email',
  handoffTitle: 'Autorizado',
  handoffH1: 'Autorizado — volviendo al cliente',
  handoffMuted: 'Si no se redirige automáticamente, use el enlace de abajo.',
  handoffLink: 'Volver al cliente',
  authorizeTitle: 'Autorizar',
  authorizeH1: 'Autorizar aplicación',
  wantsAccess: ' quiere acceso a una identidad OpenAgent vía MCP.',
  wantsAccessAfter: '',
  metaClient: 'Cliente',
  metaClientIdHost: 'Host del Client ID',
  metaRedirectHost: 'Host de redirección',
  metaClientId: 'Client ID',
  loopbackWarnBefore: 'Este cliente redirige a una dirección loopback (',
  loopbackWarnAfter: '). Continúe solo si inició usted esta autorización.',
  linkLoginNotice: 'Sesión iniciada por enlace como Admin session',
  chooseIdentity: 'Elegir identidad',
  existingIdentity: 'Identidad existente',
  createIdentity: 'Crear una identidad nueva',
  localpartPlaceholder: 'localpart',
  approve: 'Aprobar',
  deny: 'Denegar',
  forbiddenTitle: 'Prohibido',
  forbiddenH1: 'Se requiere sesión de administrador',
  forbiddenBody: 'El consentimiento OAuth es solo del propietario. Inicie sesión con un admin API token.',
  backToInbox: '← Volver al buzón',
  authErrorTitle: 'Error de autorización',
  authErrorH1: 'Error de autorización',
  malformedBody: 'Cuerpo mal formado.',
  invalidFormFieldTypes: 'Tipos de campo de formulario no válidos.',
  invalidLocalpart: 'localpart no válido.',
  addressTaken: 'Esa dirección ya está en uso.',
  notifyProvisionFailed: 'Falló el aprovisionamiento de notificaciones; no se creó la identidad.',
  provisionFailed: 'No se pudo aprovisionar la identidad.',
  unknownIdentity: 'Identidad desconocida.',
};

const JA: OAuthCopy = {
  brandSuffix: 'OpenAgent.email',
  handoffTitle: '承認済み',
  handoffH1: '承認済み — クライアントへ戻ります',
  handoffMuted: '自動で移動しない場合は、下のリンクを使用してください。',
  handoffLink: 'クライアントに戻る',
  authorizeTitle: '承認',
  authorizeH1: 'アプリケーションを承認',
  wantsAccess: ' が MCP 経由で OpenAgent アイデンティティへのアクセスを要求しています。',
  wantsAccessAfter: '',
  metaClient: 'クライアント',
  metaClientIdHost: 'Client ID ホスト',
  metaRedirectHost: 'リダイレクトホスト',
  metaClientId: 'Client ID',
  loopbackWarnBefore: 'このクライアントはループバックアドレス（',
  loopbackWarnAfter: '）へリダイレクトします。ご自身で開始した承認である場合のみ続行してください。',
  linkLoginNotice: 'リンク経由で Admin session としてサインイン済み',
  chooseIdentity: 'アイデンティティを選択',
  existingIdentity: '既存のアイデンティティ',
  createIdentity: '新しいアイデンティティを作成',
  localpartPlaceholder: 'localpart',
  approve: '承認',
  deny: '拒否',
  forbiddenTitle: '禁止',
  forbiddenH1: '管理者セッションが必要です',
  forbiddenBody: 'OAuth 同意はオーナー専用です。admin API token でサインインしてください。',
  backToInbox: '← 受信箱に戻る',
  authErrorTitle: '承認エラー',
  authErrorH1: '承認エラー',
  malformedBody: '本文の形式が不正です。',
  invalidFormFieldTypes: 'フォームフィールドの型が不正です。',
  invalidLocalpart: 'localpart が不正です。',
  addressTaken: 'そのアドレスは既に使用されています。',
  notifyProvisionFailed: '通知のプロビジョニングに失敗したため、アイデンティティは作成されませんでした。',
  provisionFailed: 'アイデンティティのプロビジョニングに失敗しました。',
  unknownIdentity: '不明なアイデンティティです。',
};

const KO: OAuthCopy = {
  brandSuffix: 'OpenAgent.email',
  handoffTitle: '승인됨',
  handoffH1: '승인됨 — 클라이언트로 돌아가는 중',
  handoffMuted: '자동으로 이동하지 않으면 아래 링크를 사용하세요.',
  handoffLink: '클라이언트로 돌아가기',
  authorizeTitle: '승인',
  authorizeH1: '애플리케이션 승인',
  wantsAccess: ' 이(가) MCP를 통해 OpenAgent 아이덴티티 접근을 요청합니다.',
  wantsAccessAfter: '',
  metaClient: '클라이언트',
  metaClientIdHost: 'Client ID 호스트',
  metaRedirectHost: '리디렉션 호스트',
  metaClientId: 'Client ID',
  loopbackWarnBefore: '이 클라이언트는 루프백 주소(',
  loopbackWarnAfter: ')로 리디렉션합니다. 본인이 시작한 승인인 경우에만 계속하세요.',
  linkLoginNotice: '링크로 Admin session으로 로그인됨',
  chooseIdentity: '아이덴티티 선택',
  existingIdentity: '기존 아이덴티티',
  createIdentity: '새 아이덴티티 만들기',
  localpartPlaceholder: 'localpart',
  approve: '승인',
  deny: '거부',
  forbiddenTitle: '금지됨',
  forbiddenH1: '관리자 세션 필요',
  forbiddenBody: 'OAuth 동의는 소유자 전용입니다. admin API token으로 로그인하세요.',
  backToInbox: '← 받은편지함으로 돌아가기',
  authErrorTitle: '승인 오류',
  authErrorH1: '승인 오류',
  malformedBody: '본문 형식이 올바르지 않습니다.',
  invalidFormFieldTypes: '폼 필드 유형이 올바르지 않습니다.',
  invalidLocalpart: 'localpart가 올바르지 않습니다.',
  addressTaken: '해당 주소는 이미 사용 중입니다.',
  notifyProvisionFailed: '알림 프로비저닝에 실패하여 아이덴티티가 생성되지 않았습니다.',
  provisionFailed: '아이덴티티 프로비저닝에 실패했습니다.',
  unknownIdentity: '알 수 없는 아이덴티티입니다.',
};

/** 既有 zh-CN 硬编码页语义保留；与控制台 zh-CN 术语对齐。 */
const ZH_CN: OAuthCopy = {
  brandSuffix: 'OpenAgent.email',
  handoffTitle: '已授权',
  handoffH1: '已授权，正在跳回客户端',
  handoffMuted: '若未自动跳转，请点击下方链接继续。',
  handoffLink: '返回客户端',
  authorizeTitle: '授权',
  authorizeH1: '授权应用',
  wantsAccess: ' 希望通过 MCP 访问一个 OpenAgent 身份。',
  wantsAccessAfter: '',
  metaClient: '客户端',
  metaClientIdHost: 'Client ID 主机',
  metaRedirectHost: '重定向主机',
  metaClientId: 'Client ID',
  loopbackWarnBefore: '此客户端会重定向到回环地址（',
  loopbackWarnAfter: '）。请仅在本人发起的授权流程中继续。',
  linkLoginNotice: '已通过链接以 Admin session 登录',
  chooseIdentity: '选择身份',
  existingIdentity: '已有身份',
  createIdentity: '创建新身份',
  localpartPlaceholder: 'localpart',
  approve: '批准',
  deny: '拒绝',
  forbiddenTitle: '禁止',
  forbiddenH1: '需要管理员会话',
  forbiddenBody: 'OAuth 同意仅限业主。请使用 admin API token 登录。',
  backToInbox: '← 返回收件箱',
  authErrorTitle: '授权错误',
  authErrorH1: '授权错误',
  malformedBody: '请求体格式错误。',
  invalidFormFieldTypes: '表单字段类型无效。',
  invalidLocalpart: 'localpart 无效。',
  addressTaken: '该地址已被占用。',
  notifyProvisionFailed: '通知配置失败；身份未创建。',
  provisionFailed: '身份配置失败。',
  unknownIdentity: '未知身份。',
};

const OAUTH_COPY: Record<UiLocale, OAuthCopy> = {
  en: EN,
  es: ES,
  ja: JA,
  ko: KO,
  'zh-CN': ZH_CN,
};

/** 按会话 locale 取 OAuth 页文案。 */
export function oauthCopy(locale: UiLocale): OAuthCopy {
  return OAUTH_COPY[locale] || EN;
}
