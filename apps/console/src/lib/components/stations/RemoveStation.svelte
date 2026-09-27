<script lang="ts">
 import * as Dialog from '$lib/components/ui/dialog';
 import { Button } from '$lib/components/ui/button';
 import { removeStation } from '$lib/api/station-setup';
 let {stationId,displayName,onRemoved}:{stationId:string;displayName:string;onRemoved:()=>void}=$props();
 let open=$state(false),busy=$state(false),problem=$state('');
 async function remove(){
  if(busy)return;
  busy=true;problem='';
  try{await removeStation(stationId);open=false;onRemoved();}catch(e){problem=(e as Error).message;}finally{busy=false;}
 }
</script>
<Button size="sm" variant="outline" onclick={()=>{problem='';open=true;}}>Remove station</Button>
<Dialog.Root {open} onOpenChange={v=>{if(!busy)open=v;}}>
 <Dialog.Content showCloseButton={false} onEscapeKeydown={e=>{if(busy)e.preventDefault();}} onInteractOutside={e=>{if(busy)e.preventDefault();}}>
  <Dialog.Header><Dialog.Title>Remove {displayName} from AgentPod?</Dialog.Title>
   <Dialog.Description>This unregisters the station. Its workspace files, installed skills, agent identity, and existing grants are kept. Running processes are not stopped.</Dialog.Description>
  </Dialog.Header>
  <p class="text-sm">The station’s skill-operation history and Matrix routing records are deleted. Matrix messages are not deleted from the homeserver. You can register the workspace again and assign its existing identity, but the deleted records are not restored.</p>
  {#if problem}<p role="alert" class="text-sm text-destructive">{problem}</p>{/if}
  <Dialog.Footer><Button variant="outline" disabled={busy} onclick={()=>open=false}>Cancel</Button><Button variant="destructive" disabled={busy} onclick={remove}>{busy?'Removing…':'Remove from AgentPod'}</Button></Dialog.Footer>
 </Dialog.Content>
</Dialog.Root>
