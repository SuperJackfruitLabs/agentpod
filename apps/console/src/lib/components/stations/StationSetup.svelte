<script lang="ts">
 import { untrack } from "svelte";
 import * as Dialog from '$lib/components/ui/dialog';
 import { Button } from '$lib/components/ui/button';
 import { Input } from '$lib/components/ui/input';
 import { Label } from '$lib/components/ui/label';
 import { adoptStations } from '$lib/api/client';
 import { getSetupOptions, completeStationSetup, retryStationMatrix, type SetupOptions, type SetupInput, type SetupResult } from '$lib/api/station-setup';
 interface Target { id?:string; nodeId:string; stationKey:string; displayName:string }
 let {open=$bindable(false),target,onComplete}:{open:boolean;target:Target;onComplete:()=>void}=$props();
 let options=$state<SetupOptions|null>(null), loading=$state(true), busy=$state(false), problem=$state('');
 let mode=$state('new'), handle=$state(''), displayName=$state(''), selected=$state(''), allowMe=$state(false);
 let stationId=$state<string|undefined>(), result=$state<SetupResult|null>(null);
 let lastRequest:SetupInput|null=null;
 let lastChoices='';
 let selectedAgent=$derived(options?.agents.find(a=>a.id===selected));
 let chosenHandle=$derived(mode==='existing'?selectedAgent?.handle:handle);
 let matrixAddress=$derived(options?.matrixDomain && chosenHandle && /^[a-z0-9.=/-]+$/.test(chosenHandle) ? `@agent_${chosenHandle}:${options.matrixDomain}`:null);
 const targetKey=$derived(`${target.nodeId}:${target.stationKey}`);
 $effect(()=>{
   if (!open) return;
   void targetKey;
   return untrack(()=>{
   let live=true;
   stationId=target.id; mode='new';handle=target.displayName.toLowerCase().replace(/[^a-z0-9.=/-]/g,'-');
   displayName=target.displayName; selected='';allowMe=false;result=null;problem='';options=null;loading=true;lastRequest=null;lastChoices='';
   getSetupOptions().then(v=>{if(live) options=v;}).catch(e=>{if(live) problem=(e as Error).message;}).finally(()=>{if(live) loading=false;});
   return ()=>{live=false;};
   });
 });
 async function save(){
  if(busy || !options) return;
  busy=true;problem='';
  try{
   if(!stationId){
    const rows=await adoptStations(target.nodeId,[target.stationKey]);
    const row=rows.find(s=>s.stationKey===target.stationKey);
    if(!row) throw new Error('Workspace registration could not be confirmed. Retry setup.');
    stationId=row.id;
   }
   if(mode==='register'){onComplete();open=false;return;}
   const choices={agent:mode==='new'?{kind:'new' as const,handle:handle.trim(),displayName:displayName.trim()}:{kind:'existing' as const,principalId:selected},dispatch:allowMe?'me' as const:'none' as const};
   const signature=JSON.stringify(choices);
   if(!lastRequest || signature!==lastChoices){lastRequest={requestId:crypto.randomUUID(),...choices};lastChoices=signature;}
   result=await completeStationSetup(stationId,lastRequest);
   onComplete();
  }catch(e){problem=(e as Error).message;}finally{busy=false;}
 }
 async function retryMatrix(){
  if(!stationId || !result?.principalId || busy) return;
  busy=true;problem='';
  try{result=await retryStationMatrix(stationId,result.principalId);onComplete();}catch(e){problem=(e as Error).message;}finally{busy=false;}
 }
</script>
<Dialog.Root {open} onOpenChange={v=>{if(!busy)open=v;}}>
 <Dialog.Content showCloseButton={false} class="flex w-[calc(100%-2rem)] max-h-[calc(100dvh-2rem)] flex-col overflow-hidden sm:max-w-xl"
  onEscapeKeydown={e=>{if(busy)e.preventDefault();}} onInteractOutside={e=>{if(busy)e.preventDefault();}}>
  <Dialog.Header class="shrink-0 text-left">
   <Dialog.Title>Set up {target.displayName}</Dialog.Title>
   <Dialog.Description>Register the workspace, assign its agent identity, and review dispatch access and Matrix chat.</Dialog.Description>
  </Dialog.Header>
  <div class="min-h-0 space-y-4 overflow-y-auto">
   {#if result}
    <p class="font-medium" role="status">{result.matrix.status==='failed'||result.matrix.status==='pending'?'Agent ready; Matrix setup pending':'Agent setup complete'}</p>
    <p class="break-all font-mono text-xs">{result.principalId}</p>
    {#if result.matrix.status==='provisioned'}<p>Matrix room ready</p>
    {:else if result.matrix.status==='no-bridge'}<p>Matrix is not configured on this hub. Identity and dispatch setup are complete.</p>
    {:else}<p class="text-sm text-muted-foreground">{result.matrix.error ?? 'A Matrix room has not been confirmed yet.'} Retry without recreating the agent or changing access.</p>{/if}
    {#if result.matrix.address}<p class="break-all font-mono text-xs">{result.matrix.address}</p>{/if}
    {#if result.matrix.mode==='harness'}<p class="text-sm text-muted-foreground">This harness runs its own Matrix client. Check its Matrix identity controls for credential adoption and connection status; a room alone does not verify the client is connected.</p>{/if}
   {:else if loading}<p role="status">Loading setup options…</p>
   {:else if options}
    <fieldset disabled={busy} class="min-w-0 space-y-4">
     <div class="space-y-2">
      <Label for="setup-mode">Agent identity</Label>
      <select id="setup-mode" bind:value={mode} class="w-full rounded-md border bg-background p-2">
       <option value="new">Create a new agent</option>
       <option value="existing">Use an unassigned agent</option>
       {#if !target.id}<option value="register">Register workspace only (advanced)</option>{/if}
      </select>
     </div>
     {#if mode==='new'}
      <div class="space-y-2"><Label for="setup-name">Display name</Label><Input id="setup-name" bind:value={displayName}/></div>
      <div class="space-y-2"><Label for="setup-handle">Agent handle</Label><Input id="setup-handle" bind:value={handle}/><p class="text-xs text-muted-foreground">Permanent identity. Use lowercase letters, numbers, dots, hyphens, equals signs, or slashes.</p></div>
     {:else if mode==='existing'}
      <div class="space-y-2"><Label for="setup-existing">Unassigned agent</Label>
       <select id="setup-existing" bind:value={selected} class="w-full rounded-md border bg-background p-2"><option value="">Choose an agent</option>{#each options.agents as a}<option value={a.id}>{a.displayName ?? a.handle} · {a.handle}</option>{/each}</select>
       {#if !options.agents.length}<p class="text-sm text-muted-foreground">No unassigned agents. Create a new agent instead.</p>{/if}
       {#if selectedAgent}<p class="text-sm">Existing dispatch access: {selectedAgent.dispatchers.join(', ') || 'Nobody'}. These permissions stay with this identity.</p>{/if}
      </div>
     {/if}
     {#if mode!=='register'}
      <div class="space-y-2 rounded-lg border p-3">
       <h3 class="font-medium">Dispatch access</h3>
       <label class="flex items-start gap-2"><input type="checkbox" bind:checked={allowMe} class="mt-1"/>Allow my account to dispatch this agent</label>
       <p class="text-xs text-muted-foreground">{allowMe?'Adds only this agent to your current dispatch permissions.':'No new dispatch permission will be granted.'} Existing permissions and reach access stay unchanged.</p>
      </div>
      <div class="space-y-2 rounded-lg border p-3"><h3 class="font-medium">Matrix chat</h3>
       {#if matrixAddress}<p class="break-all font-mono text-xs">{matrixAddress}</p><p class="text-xs text-muted-foreground">Setup will provision or reuse this identity’s room. Harness client adoption, when required, is a separate step.</p>
       {:else if !options.matrixDomain}<p class="text-sm text-muted-foreground">Matrix is not configured on this hub. You can still assign the agent.</p>
       {:else}<p class="text-sm text-muted-foreground">Choose a valid handle to preview its Matrix address.</p>{/if}
      </div>
     {:else}<p class="text-sm">This registers the workspace without an identity, dispatch access, or Matrix setup. It will show as unoccupied until you assign an agent.</p>{/if}
    </fieldset>
   {/if}
   {#if problem && stationId && !target.id && !result}<p class="text-sm">The workspace is registered. Identity setup is incomplete; retry here or use Assign agent on the station.</p>{/if}
   {#if problem}<p role="alert" class="text-sm text-destructive">{problem}</p>{/if}
  </div>
  <Dialog.Footer class="shrink-0">
   <Button variant="outline" disabled={busy} onclick={()=>open=false}>{result?'Done':'Cancel'}</Button>
   {#if result}
    {#if result.matrix.status==='failed'||result.matrix.status==='pending'}<Button disabled={busy} onclick={retryMatrix}>{busy?'Retrying…':'Retry Matrix setup'}</Button>{/if}
   {:else}<Button disabled={busy||loading||!options||(mode==='new'&&(!handle.trim()||!displayName.trim()))||(mode==='existing'&&!selected)} onclick={save}>{busy?'Setting up…':mode==='register'?'Register workspace':'Complete setup'}</Button>{/if}
  </Dialog.Footer>
 </Dialog.Content>
</Dialog.Root>
