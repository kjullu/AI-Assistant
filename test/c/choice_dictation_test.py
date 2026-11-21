"""Exercise choice timeout during native dictation and custom voice input."""
import pathlib
import subprocess
import tempfile

source = pathlib.Path('src/c/main.c').read_text()


def function(name):
    start = source.index('static void ' + name + '(')
    while source.index(';', start) < source.index('{', start):
        start = source.index('static void ' + name + '(', start + 1)
    pos = source.index('{', start) + 1
    depth = 1
    while depth:
        depth += (source[pos] == '{') - (source[pos] == '}')
        pos += 1
    return source[start:pos]


preamble = r'''
#include <assert.h>
#include <stdbool.h>
#include <stddef.h>
typedef int DictationSession;
typedef int DictationSessionStatus;
#define DictationSessionStatusSuccess 0
static DictationSession *s_dictation_session;
static bool s_show_choice, s_choice_waiting_dictation, s_choice_dictation_cancelled;
static bool s_show_home;
static char s_choice_question[32], s_chat_history[32] = "Existing conversation";
static int s_choice_option_count, s_choice_selection, s_choice_scroll_offset;
static void *s_choice_layer;
static int prompts, answers, dictation_starts;
static void layer_set_hidden(void *layer, bool hidden) {}
static void update_display(const char *status) {}
static void dictation_session_start(DictationSession *session) { dictation_starts++; }
static void handle_voice_transcript(const char *text, bool choice) {
  if (choice) answers++; else prompts++;
}
#ifdef HAS_MIC_STREAM
typedef int AppTimer;
static AppTimer timer, *s_voice_phone_wait_timer;
static bool s_voice_waiting_for_phone, s_voice_waiting_for_choice;
static bool s_voice_for_choice, s_voice_listening, s_voice_transcribing;
enum { VoiceUiHidden, VoiceUiRecording, VoiceUiWorking, VoiceUiFailed };
static int s_voice_ui, stops, discards, timer_cancels, voice_timer_cancels;
static void app_timer_cancel(AppTimer *t) { assert(t); timer_cancels++; }
static void voice_cancel_timers(void) { voice_timer_cancels++; }
static void set_voice_ui(int ui) { s_voice_ui = ui; }
static void mic_stream_to_phone_stop(void) { stops++; }
static bool send_voice_end(bool transcribe) { assert(!transcribe); discards++; return true; }
'''

voice = '\n'.join(function(n) for n in ['close_voice_ui', 'cancel_voice_recording'])
body = '\n'.join(function(n) for n in [
    'close_choice_screen', 'dictation_callback', 'start_pebble_dictation'
])
tests = r'''
int main(void) {
  s_show_choice = true;
  start_pebble_dictation(true);
  close_choice_screen(); // Phone sends ChoiceCancel at the 60-second deadline.
  assert(!s_show_choice && s_choice_waiting_dictation);
  // Even if another choice opens before the old modal returns, discard its result.
  s_show_choice = true;
  start_pebble_dictation(true);
  assert(dictation_starts == 1);
  dictation_callback(NULL, DictationSessionStatusSuccess, "Late answer", NULL);
  assert(prompts == 0 && answers == 0);
  assert(!s_choice_waiting_dictation && !s_choice_dictation_cancelled);
  // A subsequent choice answer still works.
  start_pebble_dictation(true);
  dictation_callback(NULL, DictationSessionStatusSuccess, "Current answer", NULL);
  assert(answers == 1 && prompts == 0);
  // A cancelled modal also consumes the timeout marker.
  start_pebble_dictation(true);
  close_choice_screen();
  dictation_callback(NULL, 1, "", NULL);
  start_pebble_dictation(false);
  dictation_callback(NULL, DictationSessionStatusSuccess, "New prompt", NULL);
  assert(prompts == 1 && answers == 1);
#ifdef HAS_MIC_STREAM
  // Custom choice recording is stopped and its transcription is invalidated.
  s_voice_for_choice = true;
  s_voice_listening = true;
  s_voice_ui = VoiceUiRecording;
  close_choice_screen();
  assert(!s_voice_listening && !s_voice_transcribing && stops == 1 && discards == 1);
  assert(s_voice_ui == VoiceUiHidden && voice_timer_cancels == 1);
  s_voice_transcribing = true;
  s_voice_ui = VoiceUiWorking;
  close_choice_screen();
  assert(!s_voice_transcribing && discards == 2 && s_voice_ui == VoiceUiHidden);
  // A deferred choice recording must not start after timeout either.
  s_voice_waiting_for_phone = s_voice_waiting_for_choice = true;
  s_voice_phone_wait_timer = &timer;
  close_choice_screen();
  assert(!s_voice_waiting_for_phone && !s_voice_phone_wait_timer && timer_cancels == 1);
  // Closing a choice does not stop dictation for an ordinary prompt.
  s_voice_for_choice = false;
  s_voice_listening = true;
  s_voice_ui = VoiceUiRecording;
  close_choice_screen();
  assert(s_voice_listening && discards == 2);
#endif
}
'''

with tempfile.TemporaryDirectory() as directory:
    c = pathlib.Path(directory) / 'choice.c'
    c.write_text(preamble + voice + '\n#endif\n' + body + tests)
    for platform in [[], ['-DHAS_MIC_STREAM']]:
        binary = pathlib.Path(directory) / 'choice'
        subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', '-Werror',
                        '-Wno-unused-parameter', *platform, str(c), '-o', str(binary)], check=True)
        subprocess.run([str(binary)], check=True)
print('Choice dictation C regression checks passed with and without mic streaming')
