<script lang="ts">
 import type { StationRow } from '$lib/api/client';
 import { getStationSetup, retryStationMatrix, type SetupResult } from '$lib/api/station-setup';
 import { Button } from '$lib/components/ui/button';
 import StationSetup from './StationSetup.svelte';
 let {station,onChanged}:{station:StationRow;onChanged?:()=>void}=$props();
 let open=$state(false), setupState=$state<SetupResult|null>(null), problem=$state(''), busy=$state(false);
 $effect(()=>{
  const id=station.id, principal=station.principalId;
  setupState=null;problem='';
  if(!principal)return;
  let live=true;
  getStationSetup(id).then(v=>{if(live)setupState=v;}).catch(e=>{if(live)problem=(e as Error).message;});
  return()=>{live=false;};
 });
 async function retry(){
  if(busy||!station.principalId)return;
  busy=true;problem='';
  try{setupState=await retryStationMatrix(station.id,station.principalId);onChanged?.();}catch(e){problem=(e as Error).message;}finally{busy=false;}
 }
</script>
{#if !station.principalId}
 <Button size="sm" class="mt-2" onclick={()=>open=true}>Assign agent</Button>
{:else if setupState?.matrix.status==='failed'||setupState?.matrix.status==='pending'}
 <div class="mt-2 space-y-2 rounded-md border p-2"><p class="text-sm">Matrix setup pending</p>
  {#if setupState.matrix.error}<p class="text-xs text-muted-foreground">{setupState.matrix.error}</p>{/if}
  <Button size="sm" variant="outline" disabled={busy} onclick={retry}>{busy?'Retrying…':'Retry Matrix setup'}</Button>
 </div>
{:else if setupState?.matrix.status==='no-bridge'}<p class="mt-2 text-xs text-muted-foreground">Matrix is not configured on this hub.</p>{/if}
{#if problem}<p role="alert" class="mt-2 text-xs text-destructive">{problem}</p>{/if}
<StationSetup bind:open target={{id:station.id,nodeId:station.nodeId,stationKey:station.stationKey,displayName:station.displayName}} onComplete={()=>onChanged?.()}/>
