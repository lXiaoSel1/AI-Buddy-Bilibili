export function fail(code, message = code, details = {}) {
  return Object.assign(new Error(message), {code, details});
}
export function assert(value, code, message = code, details = {}) {
  if (!value) throw fail(code, message, details);
  return value;
}
export function publicError(error) {
  return {code: typeof error?.code === 'string' ? error.code : 'PLUGIN_REQUEST_FAILED', message: '操作未完成，请查看插件状态。', ...(error?.code === 'SOCIAL_MODEL_NOT_SUBMITTED' && ['MEMORY_CONTEXT_CAPACITY','MODEL_CONTEXT_CAPACITY','BILI_FULL_MODEL_CAPACITY','MODEL_IMAGE_TOO_LARGE'].includes(error.causeCode) ? {causeCode:error.causeCode} : {})};
}
