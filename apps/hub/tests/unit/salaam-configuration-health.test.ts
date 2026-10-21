import { expect, test } from "bun:test";
import { configurationHealthFrom } from "../../src/services/harness-config-apply";
const health = {running:true,pid:42,cpuPct:null,memBytes:null,diskBytes:null,uptimeSec:null,lastActivity:null,note:null};
test("Salaam configuration activation is optional for old nodes and requires live typed health",()=>{
  const configurationDigest="a".repeat(64);
  expect(configurationHealthFrom(health)).toEqual({pid:42,configurationDigest:null});
  expect(configurationHealthFrom({...health,configurationDigest})).toEqual({pid:42,configurationDigest});
  for (const mutation of [{running:false},{pid:null},{pid:0},{configurationDigest:"invalid"}]) {
    expect(configurationHealthFrom({...health,configurationDigest,...mutation}).configurationDigest).toBeNull();
  }
  expect(configurationHealthFrom({configurationDigest})).toEqual({pid:null,configurationDigest:null});
});
