'use strict';
// Read-only validation inside the existing Gateway. No provider requests.
const path = require('node:path');
const { StoryboardStore } = require('/app/src/storyboard-store');
const { collectCompleted, storyboardPlan } = require('/app/src/storyboard-progress');
async function main() {
    const store = new StoryboardStore(process.env.STORYBOARD_PRIVATE_DIR,
        process.env.GATEWAY_TOKEN || process.env.NORVA_MEDIA_GATEWAY_TOKEN);
    const jobs = await store.load();
    const checks = [];
    for (const job of jobs) {
        if (job.terminal) { checks.push({ terminal: true }); continue; }
        const state = { dir: path.join(store.dir(job.jobId), 'frames'),
            plan: storyboardPlan(job.duration), next: 0 };
        await collectCompleted(state);
        const saved = Number(job.progress?.next || 0);
        if (state.next < saved) throw Error('Checkpoint references missing frames');
        checks.push({ terminal: false, savedFrames: saved, intactFrames: state.next, plannedFrames: state.plan.count });
    }
    console.log(JSON.stringify({ verifiedJobs: checks.length, checks }));
}
main().catch(() => { console.error('Checkpoint validation failed'); process.exitCode = 1; });
