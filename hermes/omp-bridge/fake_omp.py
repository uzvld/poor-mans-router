"""Explicit synthetic subprocess fixture, NOT an OMP emulator/parity claim."""
import json
from pathlib import Path
import sys

def emit(obj):
    sys.stdout.write(json.dumps(obj) + '\n'); sys.stdout.flush()
def reply(cmd, data=None, success=True):
    emit({'type':'response','id':cmd['id'],'command':cmd['type'],'success':success,
          'data':data, **({'error':'synthetic failure'} if not success else {})})
def flag(name, default=None):
    return sys.argv[sys.argv.index(name)+1] if name in sys.argv else default
session_dir=Path(flag('--session-dir', '.'))
file=Path(flag('--resume', str(session_dir/'synthetic-native.jsonl')))
state={'sessionId':'synthetic-native', 'sessionFile':str(file.resolve()),
       'model':{'provider':'backend','id':'nested/model'}, 'isStreaming':False, 'messageCount':0}
if '--session-dir' in sys.argv:
    session_dir.mkdir(exist_ok=True)
    if file.exists(): state.update(json.loads(file.read_text()))
    else: file.write_text(json.dumps(state))
def finish(text='SYNTHETIC_OK', aborted=False):
    state['isStreaming']=False; state['messageCount']+=2
    if '--session-dir' in sys.argv: file.write_text(json.dumps(state))
    emit({'type':'message_end','message':{'role':'assistant','stopReason':'aborted' if aborted else 'stop',
          'content':[{'type':'text','text':text}]}})
    emit({'type':'agent_end','messages':[]})
live_agent=False
def run_turn(text):
    global live_agent
    if text=='/local':
        emit({'type':'command_output','text':text}); return False
    if text=='/latefail':
        return 'fail'
    state['isStreaming']=True; live_agent=True; emit({'type':'agent_start'})
    if text=='/wait':
        return 'wait'
    if text=='/permission':
        emit({'type':'extension_ui_request','id':'permission-1','method':'confirm','title':'Synthetic approval','message':'Allow synthetic action?'})
        return 'wait'
    if text=='/fallback':
        emit({'type':'message_start','message':{'role':'assistant','model':'a-model','provider':'p'}})
        emit({'type':'model_changed'})
        emit({'type':'retry_fallback_applied','from':'p/a-model','to':'p/b-model','role':'p/*'})
        emit({'type':'auto_retry_start','attempt':1,'maxAttempts':3,'delayMs':0,'errorMessage':'429','errorId':429})
        emit({'type':'extension_ui_request','id':'n-1','method':'notify','message':'[omp:router] p/b-model -> p/c-model (cooldown)','notifyType':'info'})
        emit({'type':'message_update','assistantMessageEvent':{'type':'text_delta','delta':'recovered'}})
        finish('recovered')
        return True
    if text=='/tool':
        emit({'type':'tool_execution_start','toolName':'bash','title':'echo hi'})
        emit({'type':'command_output','text':'hi'})
        emit({'type':'tool_execution_end','toolName':'bash'})
        emit({'type':'message_update','assistantMessageEvent':{'type':'text_delta','delta':'did it'}})
        finish('did it')
        return True
    if text=='/interleave':
        emit({'type':'message_update','assistantMessageEvent':{'type':'text_delta','delta':'A'}})
        emit({'type':'tool_execution_start','toolName':'bash','title':'step1'})
        emit({'type':'command_output','text':'B'})
        emit({'type':'tool_execution_end','toolName':'bash'})
        emit({'type':'message_update','assistantMessageEvent':{'type':'text_delta','delta':'C'}})
        finish('AC')
        return True
    if text=='/think':
        emit({'type':'message_update','assistantMessageEvent':{'type':'thinking_delta','delta':'pondering'}})
        emit({'type':'message_update','assistantMessageEvent':{'type':'thinking_delta','delta':' more'}})
        emit({'type':'message_update','assistantMessageEvent':{'type':'text_delta','delta':'answer'}})
        finish('answer')
        return True
    if text=='/native-abort':
        emit({'type':'message_update','assistantMessageEvent':{'type':'text_delta','delta':'partial'}})
        finish('partial', aborted=True)
        return True
    emit({'type':'message_update','assistantMessageEvent':{'type':'text_delta','delta':text}})
    finish(text)
    return True
if '--silent' not in sys.argv:
    emit({'type':'ready', 'supportedProtocolVersions':[1,2]})
for line in sys.stdin:
    cmd=json.loads(line); typ=cmd['type']
    if typ=='negotiate_protocol': reply(cmd, {'protocolVersion':2})
    elif typ=='echo':
        emit({'type':'message_update','assistantMessageEvent':{'type':'text_delta','delta':'interleaved'}})
        reply(cmd, cmd.get('value'))
    elif typ=='fail': reply(cmd, success=False)
    elif typ=='exit': sys.exit(7)
    elif typ=='invalid':
        sys.stdout.write('[]\n'); sys.stdout.flush()
    elif typ=='never': pass
    elif typ=='get_state': reply(cmd, state)
    elif typ=='get_available_models': reply(cmd, {'models':[state['model'], {'provider':'cursor','id':'cursor-grok-4.6'}]})
    elif typ=='get_available_commands': reply(cmd, {'commands':[{'name':'skill:fixture','source':'skill'}]})
    elif typ=='set_model':
        state['model']={'provider':cmd['provider'],'id':cmd['modelId']}; reply(cmd, state['model'])
    elif typ=='get_launch': reply(cmd, {'argv':sys.argv})
    elif typ=='steer': reply(cmd, {'message':cmd['message']})
    elif typ=='extension_ui_response':
        finish(json.dumps(cmd,sort_keys=True))
    elif typ in ('prompt','follow_up'):
        if typ=='follow_up' and not live_agent:
            # Real OMP: a follow_up with no live agent in this process (cold
            # --resume) is acked and then emits nothing at all.
            reply(cmd); continue
        text=cmd['message']
        outcome = run_turn(text)
        if outcome is False:
            reply(cmd, {'agentInvoked':False}); continue
        if outcome == 'fail':
            reply(cmd); reply(cmd, success=False); continue
        if outcome == 'wait':
            reply(cmd); continue
        reply(cmd)
    elif typ=='abort':
        reply(cmd)
        if state['isStreaming']: finish(aborted=True)
    else: reply(cmd, success=False)
