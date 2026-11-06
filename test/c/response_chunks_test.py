"""Exercise actual chunk acceptance with lost packets and replacement replies."""
import pathlib
import subprocess
import tempfile

source = pathlib.Path('src/c/main.c').read_text()
start = source.index('static bool accept_response_chunk(')
end = source.index('static void stop_chat_reply_timer(void) {', start)
program = r'''
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>
#include <stdio.h>
static int32_t s_next_response_chunk;
static bool s_request_active, s_cancel_pending;
static uint32_t s_active_request_id;
static char s_assistant_response[512], history[1024];
static const char *status;
static int vibrations;
static void utf8_copy(char *dst, size_t size, const char *text) { snprintf(dst,size,"%s",text); }
static void append_chat_history(const char *text) { strcat(history,text); }
static void update_display(const char *text) { status=text; }
static void vibes_double_pulse(void) { vibrations++; }
'''
program += source[start:end]
program += r'''
int main(void) {
  // All text is lost, but the empty final packet at index 2 arrives.
  s_request_active=true; s_active_request_id=4;
  assert(!accept_response_chunk(2));
  assert(!s_request_active && s_active_request_id==5);
  assert(strstr(history,"Reply interrupted") && s_assistant_response[0]);
  assert(strcmp(status,"Reply interrupted")==0 && vibrations==1);
  // Normal delivery, including an empty final packet, is accepted in order.
  assert(accept_response_chunk(0));
  assert(accept_response_chunk(1));
  assert(accept_response_chunk(2));
  // Tool rounds and non-streaming fallback can replace a reply from index zero.
  assert(accept_response_chunk(0));
  assert(accept_response_chunk(1));
  // A missing middle packet also gives an error instead of truncated success.
  s_request_active=true; s_cancel_pending=true;
  assert(!accept_response_chunk(3));
  assert(!s_request_active && !s_cancel_pending && vibrations==2);
}
'''
with tempfile.TemporaryDirectory() as directory:
    c = pathlib.Path(directory) / 'chunks.c'
    c.write_text(program)
    binary = pathlib.Path(directory) / 'chunks'
    subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', '-Werror', str(c), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
print('Response chunk C regression checks passed')
