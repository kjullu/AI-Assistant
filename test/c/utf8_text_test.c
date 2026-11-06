#include <assert.h>
#include <string.h>
#include "../../src/c/utf8_text.h"

int main(void) {
  // Exercise every possible cut through 2-, 3- and 4-byte codepoints.
  const char *samples[] = {"aæøåz", "✅❌⚠z", "a🚀🔥🫠z", "plain text"};
  char dest[64];
  for (size_t s = 0; s < sizeof(samples) / sizeof(samples[0]); s++) {
    const char *text = samples[s];
    for (size_t cap = 1; cap <= strlen(text) + 2; cap++) {
      memset(dest, 0x7f, sizeof(dest));
      utf8_copy(dest, cap, text);
      size_t used = strlen(dest);
      assert(used < cap);
      assert(memcmp(dest, text, used) == 0);
      assert(((unsigned char)text[used] & 0xc0) != 0x80);
      assert(dest[cap] == 0x7f);
    }
  }
  // The choice question's actual 256-byte buffer and reported failure case.
  char question[300];
  memset(question, 'x', 200);
  strcpy(question + 200, "✅❌🚀✅❌🚀✅❌🚀✅❌🚀✅❌🚀✅❌🚀");
  char choice[256];
  utf8_copy(choice, sizeof(choice), question);
  assert(strlen(choice) == 253);
  assert(((unsigned char)question[strlen(choice)] & 0xc0) != 0x80);
  char untouched = 'x';
  utf8_copy(&untouched, 0, "🚀");
  assert(untouched == 'x');
  return 0;
}
