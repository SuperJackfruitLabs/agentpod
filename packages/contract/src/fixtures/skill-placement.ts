import { planFixture } from './skill-install';
export const placementFixture = {
 ...planFixture,action:'activate',expectedInstallationHead:'1'.repeat(64),
 repositoryPath:'/fixture/workspace',repositoryIdentity:'2'.repeat(64),
 targetPath:'/fixture/workspace/.agents/skills/sjl-fixture',
 nativeLayout:'codex-direct-v1',discoveryNames:['sjl-fixture'],activation:'quiescent-project; loading-unverified',
};
