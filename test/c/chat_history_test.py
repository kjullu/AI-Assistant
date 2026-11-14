"""Check that a full transcript drops its oldest turns instead of new text."""
import pathlib
import subprocess
import tempfile

source = pathlib.Path('src/c/main.c').read_text()
start = source.index('// When the transcript is full, drop the oldest turns')
end = source.index('static void append_tool_activity_to_history(', start)
program = r'''
#include <assert.h>
#include <string.h>
#include "utf8_text.h"
static char s_chat_history[64];
static char *s_current_ai_response_start = NULL;
''' + source[start:end] + r'''
int main(void) {
  append_chat_history("You\nfirst\n\nAI\nreply one");
  append_chat_history("\n\nYou\nsecond\n\nAI\n");
  s_current_ai_response_start = s_chat_history + strlen(s_chat_history);
  // Fits: nothing is dropped.
  append_chat_history("short");
  assert(strncmp(s_chat_history, "You\nfirst", 9) == 0);
  // Overflow: the first turn goes, the current turn and its reply start stay intact.
  append_chat_history(" and a much longer reply text");
  assert(strcmp(s_chat_history, "You\nsecond\n\nAI\nshort and a much longer reply text") == 0);
  assert(strncmp(s_current_ai_response_start, "short", 5) == 0);
  // A reply larger than the whole buffer keeps its newest lines and never overflows.
  for (int i = 0; i < 20; i++) append_chat_history("line of text\n");
  assert(strlen(s_chat_history) < sizeof(s_chat_history));
  assert(strncmp(s_chat_history, "line of text\n", 13) == 0);
  assert(s_current_ai_response_start == s_chat_history);
  // One oversized append is clipped, not written past the end.
  char big[200]; memset(big, 'x', sizeof(big) - 1); big[sizeof(big) - 1] = '\0';
  append_chat_history(big);
  assert(strlen(s_chat_history) == sizeof(s_chat_history) - 1);
}
'''
with tempfile.TemporaryDirectory() as directory:
    c = pathlib.Path(directory) / 'history.c'
    c.write_text(program)
    binary = pathlib.Path(directory) / 'history'
    subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-Isrc/c', str(c), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
print('Chat history C regression checks passed')
