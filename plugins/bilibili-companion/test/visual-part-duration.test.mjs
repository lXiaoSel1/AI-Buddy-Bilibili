import test from 'node:test';
import assert from 'node:assert/strict';
import {createBilibiliHttpPlatform} from '../src/http-platform.mjs';

test('preview reading uses the selected CID duration rather than aggregate multipart duration',async()=>{const platform=createBilibiliHttpPlatform({request:async()=>({status:200,json:{code:0,data:{bvid:'BV12345678',aid:1,cid:123,title:'Two-part fixture',duration:900,pages:[{cid:123,duration:300},{cid:124,duration:600}]}}})}),video=await platform.selectVideo({connectionRef:'account',videoId:'BV12345678',context:{contextToken:'scope',characterId:'deepseek',lifeId:'life',operationId:'op',accountId:'10001'},lease:{leaseId:'lease',generation:1}});assert.equal(video.duration,300);assert.equal(video.cid,123);assert.equal(video.pageCount,2);});
