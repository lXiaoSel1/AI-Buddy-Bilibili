import {registerNativePlugin} from '../../../shared/native.mjs';
import {createBilibiliService,BILI_UNCONNECTED} from './service.mjs';
export {createBilibiliService} from './service.mjs';
import {VERSION} from './defaults.mjs';
export const name='ai-buddy-bilibili-companion';
export const inject=['tools','connection','buddySocialServices'];
export function apply(ctx){return registerNativePlugin(ctx,{pluginId:'@ai-buddy/bilibili-companion',label:'B站陪伴',version:VERSION,createService:createBilibiliService,unconnected:BILI_UNCONNECTED});}
