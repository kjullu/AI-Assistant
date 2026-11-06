"""Run the actual disconnect handler against deterministic watch state."""
import pathlib
import subprocess
import tempfile

source = pathlib.Path('src/c/main.c').read_text()
start = source.index('static void phone_connection_changed(')
end = source.index('\nstatic void outbox_failed_callback', start)
program = r'''
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>
#include <stdio.h>
#define HAS_MIC_STREAM 1
static bool s_phone_ready, s_request_active, s_cancel_pending;
static uint32_t s_active_request_id;
typedef int AppTimer;
static AppTimer timer;
static AppTimer *s_chat_reply_timer;
#define CHAT_REPLY_WAIT_MS 90000
#define MESSAGE_KEY_CancelRequest 1
static bool timer_ok=true;
static int registered, cancelled, cancel_commands;
static void app_timer_cancel(AppTimer *t) { assert(t); cancelled++; }
static AppTimer *app_timer_register(int ms, void (*fn)(void *), void *ctx) {
  assert(ms==90000); registered++; return timer_ok ? &timer : NULL;
}
static bool send_simple_command(uint32_t key, const char *failure) { cancel_commands++; return false; }
static char s_assistant_response[512];
static void utf8_copy(char *dst,size_t cap,const char *text) { snprintf(dst,cap,"%s",text); }
static int closed, notices, vibrations;
static const char *status;
static void close_choice_screen(void) { closed++; }
static void append_chat_history(const char *text) {
  if (strcmp(text,"\n\n")==0) return;
  assert(strstr(text, "Reconnect and try again") || strstr(text, "Reply timed out. Try again.")); notices++;
}
static void update_display(const char *text) { status=text; }
static void vibes_double_pulse(void) { vibrations++; }
'''
timer_start = source.index('static void stop_chat_reply_timer(void) {')
timer_end = source.index('// Receive status, errors, and response chunks', timer_start)
program += source[timer_start:timer_end] + source[start:end]
program += r'''
int main(void) {
  s_phone_ready=true; s_request_active=true; s_active_request_id=7;
  phone_connection_changed(true);
  assert(s_request_active && s_active_request_id==7 && notices==0);
  phone_connection_changed(false);
  assert(!s_phone_ready && !s_request_active && !s_cancel_pending);
  assert(s_active_request_id==8 && closed==1 && notices==1 && vibrations==1);
  assert(strcmp(status, "Phone disconnected")==0);
  phone_connection_changed(true);
  phone_connection_changed(false);
  assert(s_active_request_id==8 && notices==1);
  s_cancel_pending=true; s_active_request_id=UINT32_MAX;
  phone_connection_changed(false);
  assert(!s_cancel_pending && s_active_request_id==1 && notices==2);
  // Miss both the disconnect notification and all companion-startup messages.
  // The request must end locally even when CancelRequest also cannot be sent.
  s_request_active=true; s_active_request_id=12;
  assert(arm_chat_reply_timer());
  assert(s_request_active); // Starting the deadline does not reject a valid prompt.
  assert(arm_chat_reply_timer()); // Current request activity extends the wait.
  assert(cancelled==1 && registered==2);
  chat_reply_timeout(NULL);
  assert(!s_request_active && !s_cancel_pending && !s_chat_reply_timer);
  assert(s_active_request_id==13 && cancel_commands==1);
  assert(strstr(s_assistant_response,"Reply timed out") && notices==3);
  chat_reply_timeout(NULL); assert(notices==3); // Completed/cancelled turns stay done.
  // Retry gets a fresh deadline, explicit cleanup removes it.
  s_request_active=true; assert(arm_chat_reply_timer());
  stop_chat_reply_timer(); assert(!s_chat_reply_timer);
  // Failing to allocate a timer must never leave an unbounded request.
  timer_ok=false; assert(!arm_chat_reply_timer());
  assert(!s_request_active && notices==4);
  s_cancel_pending=true;
  int commands_before=cancel_commands;
  chat_reply_timeout(NULL);
  assert(!s_cancel_pending && cancel_commands==commands_before && notices==5);

}
'''
with tempfile.TemporaryDirectory() as directory:
    c = pathlib.Path(directory) / 'disconnect.c'
    c.write_text(program)
    binary = pathlib.Path(directory) / 'disconnect'
    subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-Wno-unused-parameter', str(c), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
print('Chat disconnect C regression checks passed')
