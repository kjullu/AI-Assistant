"""Compile actual voice-control functions against a deterministic SDK fake."""
import pathlib
import subprocess
import tempfile

source = pathlib.Path('src/c/main.c').read_text()
def function(name):
    start = source.index('static void ' + name + '(')
    # Skip forward declarations.
    while source.index(';', start) < source.index('{', start):
        start = source.index('static void ' + name + '(', start + 1)
    end = source.index('{', start)
    depth = 1
    pos = end + 1
    while depth:
        depth += (source[pos] == '{') - (source[pos] == '}')
        pos += 1
    return source[start:pos]

preamble = r'''
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
typedef int AppTimer;
static AppTimer timer;
static AppTimer *s_voice_timer, *s_voice_tick_timer, *s_voice_response_timer;
static bool s_voice_listening, s_voice_transcribing, send_ok=true, timer_ok=true;
static int stops, cancels, discards, ui;
static char s_voice_failure[48];
static uint32_t s_voice_attempt_id=2;
typedef struct { uint8_t uint8; uint32_t uint32; char *cstring; } Value;
typedef struct { Value *value; int length; } Tuple;
typedef struct { Tuple *end, *id; } DictionaryIterator;
#define MESSAGE_KEY_VoiceEnd 1
#define MESSAGE_KEY_RequestId 2
static Tuple *dict_find(DictionaryIterator *iter, int key) { return key==1 ? iter->end : iter->id; }


#define VOICE_RESPONSE_WAIT_MS 60000
#define VoiceUiHidden 0
static bool s_voice_for_choice;
static int transcripts;
static void handle_voice_transcript(const char *text, bool choice) { transcripts++; }
#define VoiceUiWorking 2
#define VoiceUiFailed 3
static void app_timer_cancel(AppTimer *t) { assert(t); cancels++; }
static AppTimer *app_timer_register(int ms, void (*fn)(void *), void *ctx) {
 assert(ms == 60000); return timer_ok ? &timer : NULL;
}
static void mic_stream_to_phone_stop(void) { stops++; }
static bool send_voice_end(bool transcribe) { if (!transcribe) discards++; return send_ok; }
static void vibes_double_pulse(void) {}
static void set_voice_ui(int state) { ui=state; }
'''
body = '\n'.join(function(n) for n in ['voice_cancel_timers', 'show_voice_failure', 'fail_voice_delivery', 'voice_response_timeout', 'finish_voice_recording'])
callback = source[source.index('  Tuple *voice_end =', source.index('static void outbox_failed_callback')):source.index('#endif', source.index('static void outbox_failed_callback'))]
body += '\nstatic void close_voice_ui(void) { voice_cancel_timers(); ui=0; }\n' + function('cancel_voice_recording')
body += '\nstatic void delivery_failed(DictionaryIterator *iter) {\n' + callback + '\n}\n'
start = source.index('  if (voice_transcript_tuple || voice_failed_tuple) {')
end = source.index('\n#endif', start)
body += '\nstatic void receive_voice(Tuple *voice_transcript_tuple, Tuple *voice_failed_tuple, Tuple *request_id_tuple) {\n' + source[start:end] + '\n}\n'
tests = r'''
int main(void) {
 s_voice_listening=true;
 finish_voice_recording();
 assert(!s_voice_listening && s_voice_transcribing && stops==1);
 assert(ui==VoiceUiWorking && s_voice_response_timer);
 voice_response_timeout(NULL);
 assert(!s_voice_transcribing && !s_voice_response_timer && ui==VoiceUiFailed && discards==1);
 // Retry succeeds, then an asynchronous failure cleans up its watchdog.
 s_voice_listening=true; finish_voice_recording();
 Value decision={.uint8=1}, id={.uint32=1};
 Tuple end={.value=&decision}, attempt={.value=&id}; DictionaryIterator iter={&end, &attempt};
 delivery_failed(&iter); // Failure from an earlier attempt is ignored.
 assert(s_voice_transcribing && s_voice_response_timer);
 id.uint32=2; decision.uint8=0; delivery_failed(&iter);
 assert(s_voice_transcribing); // Discard delivery failure is ignored.
 decision.uint8=1; delivery_failed(&iter);
 assert(!s_voice_transcribing && !s_voice_response_timer && cancels==1);
 // Old/missing reply IDs must not stop a retry's watchdog or deliver text.
 s_voice_listening=true; finish_voice_recording();
 Value text={.cstring="Current"}; Tuple transcript={.value=&text, .length=8};
 id.uint32=1;
 receive_voice(&transcript, NULL, &attempt);
 receive_voice(NULL, &transcript, &attempt);
 receive_voice(&transcript, NULL, NULL);
 assert(s_voice_transcribing && s_voice_response_timer && transcripts==0);
 id.uint32=2; receive_voice(&transcript, NULL, &attempt);
 assert(!s_voice_transcribing && !s_voice_response_timer && transcripts==1 && ui==VoiceUiHidden);
 receive_voice(&transcript, NULL, &attempt); assert(transcripts==1);
 // BACK cancels the request and its watchdog, then a late deadline is harmless.
 s_voice_listening=true; finish_voice_recording();
 cancel_voice_recording();
 assert(!s_voice_transcribing && !s_voice_listening && !s_voice_response_timer && ui==0);
 int after_cancel=discards; voice_response_timeout(NULL); assert(discards==after_cancel);
 // Immediate outbox failure never leaves an active wait.
 send_ok=false; s_voice_listening=true; finish_voice_recording();
 assert(!s_voice_transcribing && !s_voice_response_timer && ui==VoiceUiFailed);
 send_ok=true; timer_ok=false; s_voice_listening=true; finish_voice_recording();
 assert(!s_voice_transcribing && ui==VoiceUiFailed);
 // A timeout after cancellation has no effect.
 int previous=discards; voice_response_timeout(NULL); assert(discards==previous);
}
'''
with tempfile.TemporaryDirectory() as directory:
    c = pathlib.Path(directory) / 'voice.c'
    c.write_text(preamble + body + tests)
    binary = pathlib.Path(directory) / 'voice'
    subprocess.run(['cc', '-std=c11', '-Wall', '-Werror', '-Wno-unused-function', str(c), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
print('Voice delivery C regression checks passed')
