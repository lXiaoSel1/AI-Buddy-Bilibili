// Only a complete JSON object or one complete outer JSON fence is accepted.
// Source material around an object is never treated as model authorization.
export function parseModelObject(value){
 if(typeof value==='string'){
  const text=value.trim(),fenced=text.match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i);
  try{value=JSON.parse(fenced?fenced[1]:text);}catch{return;}
 }
 return value!==null&&typeof value==='object'&&!Array.isArray(value)?value:undefined;
}
export function parseModelResponse(result,field='understanding'){
 if(result?.[field]!=null){const value=result[field];return value!==null&&typeof value==='object'&&!Array.isArray(value)?value:undefined;}
 return typeof result?.text==='string'?parseModelObject(result.text):undefined;
}
