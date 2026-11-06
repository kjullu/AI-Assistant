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
static int closed, notices, vibrations;
static const char *status;
static char s_assistant_response[512];
static void utf8_copy(char *dst, size_t size, const char *text) { snprintf(dst,size,"%s",text); }
static void close_choice_screen(void) { closed++; }
static void append_chat_history(const char *text) {
  if (strcmp(text,"\n\n")==0) return;
  assert(strstr(text, "Reconnect and try again")); notices++;
}
static void update_display(const char *text) { status=text; }
static void vibes_double_pulse(void) { vibrations++; }
'''
restart_start = source.index('static void companion_restarted(')
restart_end = source.index('// Receive status, errors, and response chunks', restart_start)
program += source[restart_start:restart_end] + source[start:end]
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
  // A phone runtime restart can happen without a watch disconnect event.
  s_request_active=true; s_active_request_id=9;
  companion_restarted();
  assert(!s_request_active && s_active_request_id==10 && notices==3);
  assert(strstr(s_assistant_response,"Connection lost"));
  assert(strcmp(status,"Request interrupted")==0);
  // Startup when idle, or after the disconnect handler already ran, is harmless.
  companion_restarted();
  assert(s_active_request_id==10 && notices==3);
}
'''
with tempfile.TemporaryDirectory() as directory:
    c = pathlib.Path(directory) / 'disconnect.c'
    c.write_text(program)
    binary = pathlib.Path(directory) / 'disconnect'
    subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', '-Werror', str(c), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
print('Chat disconnect C regression checks passed')
