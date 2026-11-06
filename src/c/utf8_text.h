#pragma once

#include <stddef.h>
#include <string.h>

// Input is valid UTF-8. Return a byte prefix that ends between codepoints.
static inline size_t utf8_prefix_length(const char *text, size_t limit) {
  size_t length = 0;
  while (length < limit && text[length]) {
    length++;
  }
  while (length > 0 && ((unsigned char)text[length] & 0xc0) == 0x80) {
    length--;
  }
  return length;
}

static inline void utf8_copy(char *dest, size_t capacity, const char *text) {
  if (capacity == 0) {
    return;
  }
  size_t length = utf8_prefix_length(text, capacity - 1);
  memcpy(dest, text, length);
  dest[length] = '\0';
}
