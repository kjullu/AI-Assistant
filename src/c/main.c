#include <pebble.h>

//AI: Small spacing values used to lay out the Bobby-like stacked chat view.
#define PADDING 5
#define LABEL_HEIGHT 24
#define TEXT_MEASURE_HEIGHT 12000
#define BADGE_PAD 4
#define BADGE_RADIUS 2
#define ROW_HEIGHT 30
#define TOGGLE_W 24
#define TOGGLE_H 12
#define KNOB_SIZE 8
#define DIVIDER_GAP 6

#ifdef PBL_COLOR
#define ACCENT_AI     GColorCobaltBlue
#define ACCENT_USER   GColorIslamicGreen
#define ACCENT_ERROR  GColorSunsetOrange
#define ACCENT_SELECT GColorCobaltBlue
#define COLOR_DIM     GColorDarkGray
#else
#define ACCENT_AI     GColorBlack
#define ACCENT_USER   GColorBlack
#define ACCENT_ERROR  GColorBlack
#define ACCENT_SELECT GColorBlack
#define COLOR_DIM     GColorDarkGray
#endif

// Max characters Pebble dictation should store for one spoken prompt.
#define DICTATION_BUFFER_SIZE 512
// Stores the accumulated assistant reply received from the phone.
#define RESPONSE_BUFFER_SIZE 6144
#define CHAT_HISTORY_BUFFER_SIZE 14000
#define STATS_BUFFER_SIZE 512

// Pointers to Pebble UI/session objects created at runtime.
static Window *s_window;
static ScrollLayer *s_scroll_layer;
static StatusBarLayer *s_status_layer;
static Layer *s_scroll_indicator_down;
static TextLayer *s_prompt_label_layer;
static TextLayer *s_prompt_layer;
static TextLayer *s_assistant_label_layer;
static TextLayer *s_assistant_layer;
static Layer *s_history_layer;
static Layer *s_home_layer;
static TextLayer *s_status_message_layer;
static Layer *s_sessions_layer;
static Layer *s_settings_layer;
static DictationSession *s_dictation_session;

// These buffers hold the current conversation state shown in the single text view.
static char s_last_prompt[DICTATION_BUFFER_SIZE];
static char s_assistant_response[RESPONSE_BUFFER_SIZE];
static char s_chat_history[CHAT_HISTORY_BUFFER_SIZE];
static char *s_current_ai_response_start = NULL;
static char s_status_text[64];
static char s_stats_text[STATS_BUFFER_SIZE];
static char s_sessions_text[4096];
static bool s_start_dictation_on_appear;
static bool s_show_home = true;
static bool s_request_active;
static bool s_response_started;
static bool s_show_settings;
static bool s_show_sessions;
static bool s_settings_return_home;
static int s_settings_selection;
static bool s_location_enabled;
static bool s_memory_enabled = true;
static bool s_calculator_enabled = true;
static bool s_search_enabled;
static bool s_weather_enabled = true;
static bool s_choice_enabled = true;
#ifdef _PBL_API_EXISTS_touch_service_subscribe
static AppTimer *s_touch_long_timer;
static bool s_touch_long_fired;
static bool s_touch_moved;
static int16_t s_touch_start_y;
static int16_t s_touch_last_y;
#endif

// Choice/menu screen state
#define MAX_CHOICE_OPTIONS 8
#define MAX_CHOICE_TEXT 256
static bool s_show_choice;
static char s_choice_question[MAX_CHOICE_TEXT];
static char s_choice_options[MAX_CHOICE_OPTIONS][MAX_CHOICE_TEXT];
static int s_choice_option_count;
static int s_choice_selection;
static char s_choice_answer_buffer[MAX_CHOICE_TEXT + 8];
static bool s_choice_waiting_dictation;
static Layer *s_choice_layer;

static void update_display(const char *status);
static void clear_watch_session(void);
static void send_simple_command(uint32_t key, const char *failure_status);
static void toggle_selected_setting(void);
static void open_sessions_screen(void);

static bool is_session_header(const char *line) {
  return strncmp(line, "Session ", 8) == 0;
}

static bool is_session_label(const char *line) {
  return strncmp(line, "user:", 5) == 0 || strncmp(line, "assistant:", 10) == 0 || strncmp(line, "User:", 5) == 0 || strncmp(line, "Assistant:", 10) == 0;
}

static int session_label_prefix_length(const char *line) {
  if (strncmp(line, "user:", 5) == 0 || strncmp(line, "User:", 5) == 0) {
    return 5;
  }
  if (strncmp(line, "assistant:", 10) == 0 || strncmp(line, "Assistant:", 10) == 0) {
    return 10;
  }
  return 0;
}

//AI: Measure a single line of text in a given font, returning its content height.
static int16_t measure_text_height(const char *text, GFont font, int16_t width) {
  GSize size = graphics_text_layout_get_content_size(text ? text : "", font,
                                                     GRect(0, 0, width, TEXT_MEASURE_HEIGHT),
                                                     GTextOverflowModeWordWrap, GTextAlignmentLeft);
  return size.h;
}

//AI: Draw a filled, rounded "speaker" badge with white label text. Returns badge height.
static int16_t draw_badge(GContext *ctx, int16_t x, int16_t y, int16_t max_width,
                          const char *label, GColor fill, GFont font, bool draw) {
  GSize text_size = graphics_text_layout_get_content_size(label, font,
                                                          GRect(0, 0, max_width, TEXT_MEASURE_HEIGHT),
                                                          GTextOverflowModeWordWrap, GTextAlignmentLeft);
  int16_t badge_w = text_size.w + (BADGE_PAD * 2);
  int16_t badge_h = text_size.h + BADGE_PAD;
  if (badge_h < 14) {
    badge_h = 14;
  }
  if (draw) {
    graphics_context_set_fill_color(ctx, fill);
    graphics_fill_rect(ctx, GRect(x, y, badge_w, badge_h), BADGE_RADIUS, GCornersAll);
    graphics_context_set_text_color(ctx, GColorWhite);
    graphics_draw_text(ctx, label, font, GRect(x + BADGE_PAD, y - 1, text_size.w, text_size.h + 2),
                       GTextOverflowModeWordWrap, GTextAlignmentLeft, NULL);
  }
  return badge_h;
}

//AI: Draw a dotted horizontal divider line across the given width.
static void draw_divider(GContext *ctx, int16_t x, int16_t y, int16_t width, GColor color, bool draw) {
  if (!draw) {
    return;
  }
  graphics_context_set_stroke_color(ctx, color);
  for (int16_t dx = x; dx < x + width; dx += 3) {
    graphics_draw_line(ctx, GPoint(dx, y), GPoint(dx + 1, y));
  }
}

//AI: Draw a sliding toggle switch. Knob right = on, knob left = off.
static void draw_toggle_switch(GContext *ctx, int16_t x, int16_t y, bool on, bool selected) {
  int16_t knob_x = on ? (x + TOGGLE_W - KNOB_SIZE - 2) : (x + 2);
  int16_t knob_y = y + (TOGGLE_H - KNOB_SIZE) / 2;
  int16_t radius = TOGGLE_H / 2;

  GColor track_fill, track_stroke, knob_fill;
  bool fill_track = true;
  if (selected) {
    track_stroke = GColorWhite;
    if (on) {
      track_fill = GColorWhite;
      knob_fill = ACCENT_SELECT;
    } else {
      fill_track = false;
      knob_fill = GColorWhite;
    }
  } else {
    if (on) {
      track_fill = ACCENT_SELECT;
      track_stroke = ACCENT_SELECT;
      knob_fill = GColorWhite;
    } else {
      track_fill = GColorWhite;
      track_stroke = COLOR_DIM;
      knob_fill = COLOR_DIM;
    }
  }

  if (fill_track) {
    graphics_context_set_fill_color(ctx, track_fill);
    graphics_fill_rect(ctx, GRect(x, y, TOGGLE_W, TOGGLE_H), radius, GCornersAll);
  }
  graphics_context_set_stroke_color(ctx, track_stroke);
  graphics_draw_round_rect(ctx, GRect(x, y, TOGGLE_W, TOGGLE_H), radius);
  graphics_context_set_fill_color(ctx, knob_fill);
  graphics_fill_rect(ctx, GRect(knob_x, knob_y, KNOB_SIZE, KNOB_SIZE), KNOB_SIZE / 2, GCornersAll);
}

static int16_t layout_sessions_text(GContext *ctx, GRect bounds, bool draw) {
  GFont header_font = fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD);
  GFont date_font = fonts_get_system_font(FONT_KEY_GOTHIC_14);
  GFont label_font = fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD);
  GFont body_font = fonts_get_system_font(FONT_KEY_GOTHIC_24);
  int16_t width = bounds.size.w;
  int16_t y = 0;
  char *line = s_sessions_text;

  while (line && *line) {
    char *next = strchr(line, '\n');
    if (next) {
      *next = '\0';
    }

    if (line[0] != '\0' && strcmp(line, "---") == 0) {
      draw_divider(ctx, 0, y + DIVIDER_GAP / 2, width, COLOR_DIM, draw);
      y += DIVIDER_GAP + PADDING;
    } else if (line[0] != '\0') {
      if (is_session_header(line)) {
        int16_t hh = measure_text_height(line, header_font, width);
        if (draw) {
          graphics_context_set_fill_color(ctx, ACCENT_AI);
          graphics_fill_rect(ctx, GRect(0, y, width, hh + 4), 0, GCornerNone);
          graphics_context_set_text_color(ctx, GColorWhite);
          graphics_draw_text(ctx, line, header_font, GRect(PADDING, y, width - (PADDING * 2), hh + 4),
                             GTextOverflowModeWordWrap, GTextAlignmentLeft, NULL);
        }
        y += hh + 4 + 2;
      } else if (is_session_label(line)) {
        int prefix_len = session_label_prefix_length(line);
        char prefix[16];
        char remainder[512];
        strncpy(prefix, line, prefix_len);
        prefix[prefix_len] = '\0';
        snprintf(remainder, sizeof(remainder), "%s", line + prefix_len);
        while (remainder[0] == ' ') {
          memmove(remainder, remainder + 1, strlen(remainder));
        }

        GColor label_color = (strncmp(prefix, "user", 4) == 0 || strncmp(prefix, "User", 4) == 0) ? ACCENT_USER : ACCENT_AI;
        int16_t label_h = measure_text_height(prefix, label_font, width);
        if (draw) {
          graphics_context_set_text_color(ctx, label_color);
          graphics_draw_text(ctx, prefix, label_font, GRect(PADDING, y, width - (PADDING * 2), label_h + 1),
                             GTextOverflowModeWordWrap, GTextAlignmentLeft, NULL);
        }
        y += label_h + 1;
        if (remainder[0] != '\0') {
          int16_t body_h = measure_text_height(remainder, body_font, width - (PADDING * 2));
          if (draw) {
            graphics_context_set_text_color(ctx, GColorBlack);
            graphics_draw_text(ctx, remainder, body_font, GRect(PADDING * 2, y, width - (PADDING * 3), body_h + PADDING),
                               GTextOverflowModeWordWrap, GTextAlignmentLeft, NULL);
          }
          y += body_h + PADDING;
        }
      } else if (strncmp(line, "20", 2) == 0 && strlen(line) >= 10 && strchr(line, 'T')) {
        int16_t dh = measure_text_height(line, date_font, width - (PADDING * 2));
        if (draw) {
          graphics_context_set_text_color(ctx, COLOR_DIM);
          graphics_draw_text(ctx, line, date_font, GRect(PADDING, y, width - (PADDING * 2), dh + 1),
                             GTextOverflowModeWordWrap, GTextAlignmentLeft, NULL);
        }
        y += dh + 1 + PADDING;
      } else if (strcmp(line, "No saved sessions yet.") == 0) {
        int16_t mh = measure_text_height(line, date_font, width - (PADDING * 2));
        if (draw) {
          graphics_context_set_text_color(ctx, COLOR_DIM);
          graphics_draw_text(ctx, line, date_font, GRect(PADDING, y, width - (PADDING * 2), mh + PADDING),
                             GTextOverflowModeWordWrap, GTextAlignmentCenter, NULL);
        }
        y += mh + PADDING;
      } else {
        int16_t size_h = measure_text_height(line, body_font, width - (PADDING * 2));
        if (draw) {
          graphics_context_set_text_color(ctx, GColorBlack);
          graphics_draw_text(ctx, line, body_font, GRect(PADDING, y, width - (PADDING * 2), size_h + PADDING),
                             GTextOverflowModeWordWrap, GTextAlignmentLeft, NULL);
        }
        y += size_h + PADDING;
      }
    } else {
      y += PADDING / 2;
    }

    if (next) {
      *next = '\n';
      line = next + 1;
    } else {
      break;
    }
  }

  return y + PADDING;
}

static void sessions_layer_update_proc(Layer *layer, GContext *ctx) {
  layout_sessions_text(ctx, layer_get_bounds(layer), true);
}

//AI: Settings rows are drawn directly from the live toggle states; no text buffer needed.
typedef struct {
  const char *label;
  bool enabled;
} SettingRow;

static int8_t settings_row_count(void) {
  return 6;
}

static void get_settings_row(int8_t index, SettingRow *out) {
  switch (index) {
    case 0:
      out->label = "Location";
      out->enabled = s_location_enabled;
      break;
    case 1:
      out->label = "Memory";
      out->enabled = s_memory_enabled;
      break;
    case 2:
      out->label = "Calculator";
      out->enabled = s_calculator_enabled;
      break;
    case 3:
      out->label = "Search";
      out->enabled = s_search_enabled;
      break;
    case 4:
      out->label = "Weather";
      out->enabled = s_weather_enabled;
      break;
    default:
      out->label = "Choice";
      out->enabled = s_choice_enabled;
      break;
  }
}

//AI: Measure or draw the settings list with toggles and a selection highlight bar.
static int16_t layout_settings_text(GContext *ctx, GRect bounds, bool draw) {
  GFont header_font = fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD);
  GFont row_font = fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD);
  GFont hint_font = fonts_get_system_font(FONT_KEY_GOTHIC_14);
  int16_t width = bounds.size.w;
  int16_t y = PADDING;

  if (draw) {
    graphics_context_set_text_color(ctx, ACCENT_AI);
    graphics_draw_text(ctx, "Tools", header_font, GRect(PADDING, y, width - (PADDING * 2), LABEL_HEIGHT),
                       GTextOverflowModeWordWrap, GTextAlignmentLeft, NULL);
  }
  y += LABEL_HEIGHT + 2;
  draw_divider(ctx, PADDING, y, width - (PADDING * 2), COLOR_DIM, draw);
  y += DIVIDER_GAP + PADDING;

  int8_t count = settings_row_count();
  for (int8_t i = 0; i < count; i++) {
    SettingRow row;
    get_settings_row(i, &row);
    bool selected = (i == s_settings_selection);
    int16_t row_h = ROW_HEIGHT;

    if (draw) {
      if (selected) {
        graphics_context_set_fill_color(ctx, ACCENT_SELECT);
        graphics_fill_rect(ctx, GRect(0, y, width, row_h), 0, GCornerNone);
      }
      GColor text_color = selected ? GColorWhite : GColorBlack;
      graphics_context_set_text_color(ctx, text_color);
      graphics_draw_text(ctx, row.label, row_font, GRect(PADDING, y + 5, width - (PADDING * 2) - TOGGLE_W - PADDING, row_h),
                         GTextOverflowModeWordWrap, GTextAlignmentLeft, NULL);
      draw_toggle_switch(ctx, width - PADDING - TOGGLE_W, y + (row_h - TOGGLE_H) / 2, row.enabled, selected);
    }
    y += row_h;
  }

  if (draw) {
    graphics_context_set_text_color(ctx, COLOR_DIM);
    graphics_draw_text(ctx, "SELECT toggle  UP/DN move  BACK", hint_font,
                       GRect(PADDING, y + PADDING, width - (PADDING * 2), 20),
                       GTextOverflowModeWordWrap, GTextAlignmentLeft, NULL);
  }
  y += 20 + PADDING * 2;

  return y;
}

static void settings_layer_update_proc(Layer *layer, GContext *ctx) {
  layout_settings_text(ctx, layer_get_bounds(layer), true);
}

static void open_settings_screen(void) {
  s_settings_return_home = s_show_home;
  s_show_settings = true;
  s_show_sessions = false;
  s_show_home = false;
  update_display("Ready");
}

static void open_sessions_screen(void) {
  s_settings_return_home = s_show_home;
  s_show_sessions = true;
  s_show_settings = false;
  s_show_home = false;
  update_display("Ready");
  send_simple_command(MESSAGE_KEY_OpenSessions, "Sessions unavailable");
}

static void close_choice_screen(void) {
  s_show_choice = false;
  s_choice_waiting_dictation = false;
  s_choice_question[0] = '\0';
  s_choice_option_count = 0;
  s_choice_selection = 0;
  layer_set_hidden(s_choice_layer, true);
  update_display("Ready");
}

static void send_choice_answer(void) {
  DictionaryIterator *iter;
  AppMessageResult result = app_message_outbox_begin(&iter);
  if (result != APP_MSG_OK || !iter) {
    update_display("Choice send failed");
    vibes_double_pulse();
    return;
  }

  if (s_choice_selection >= 0 && s_choice_selection < s_choice_option_count) {
    snprintf(s_choice_answer_buffer, sizeof(s_choice_answer_buffer), "%s", s_choice_options[s_choice_selection]);
    dict_write_cstring(iter, MESSAGE_KEY_ChoiceAnswer, s_choice_answer_buffer);
  } else {
    dict_write_cstring(iter, MESSAGE_KEY_ChoiceAnswer, "");
  }
  dict_write_end(iter);
  result = app_message_outbox_send();
  if (result != APP_MSG_OK) {
    update_display("Choice send failed");
    vibes_double_pulse();
    return;
  }
  close_choice_screen();
  s_show_home = false;
  update_display("Sending...");
}

static void open_choice_screen(const char *question, const char *options_text) {
  s_show_choice = true;
  s_choice_question[0] = '\0';
  s_choice_option_count = 0;
  s_choice_selection = 0;

  if (question) {
    snprintf(s_choice_question, sizeof(s_choice_question), "%s", question);
  }

  if (options_text) {
    char buf[1024];
    snprintf(buf, sizeof(buf), "%s", options_text);
    char *line = buf;
    while (line && *line && s_choice_option_count < MAX_CHOICE_OPTIONS) {
      char *next = strchr(line, '\n');
      if (next) {
        *next = '\0';
      }
      while (*line == ' ' || *line == '\t') {
        line++;
      }
      if (*line != '\0') {
        snprintf(s_choice_options[s_choice_option_count], MAX_CHOICE_TEXT, "%s", line);
        s_choice_option_count++;
      }
      if (next) {
        *next = '\n';
        line = next + 1;
      } else {
        break;
      }
    }
  }

  // Always add a "Say your own" option at the end
  if (s_choice_option_count < MAX_CHOICE_OPTIONS) {
    snprintf(s_choice_options[s_choice_option_count], MAX_CHOICE_TEXT, "Say your own");
    s_choice_option_count++;
  }

  layer_set_hidden(s_choice_layer, false);
  layer_mark_dirty(s_choice_layer);
  update_display("Choose");
}

static int16_t layout_choice_text(GContext *ctx, GRect bounds, bool draw) {
  GFont question_font = fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD);
  GFont option_font = fonts_get_system_font(FONT_KEY_GOTHIC_18);
  GFont hint_font = fonts_get_system_font(FONT_KEY_GOTHIC_14);
  int16_t width = bounds.size.w;
  int16_t y = PADDING;

  // Question header background
  int16_t question_h = measure_text_height(s_choice_question[0] ? s_choice_question : "Question", question_font, width - (PADDING * 2));
  if (question_h < 20) {
    question_h = 20;
  }
  if (draw) {
    graphics_context_set_fill_color(ctx, ACCENT_AI);
    graphics_fill_rect(ctx, GRect(0, y, width, question_h + PADDING * 2), 0, GCornerNone);
    graphics_context_set_text_color(ctx, GColorWhite);
    graphics_draw_text(ctx, s_choice_question[0] ? s_choice_question : "Question", question_font,
                       GRect(PADDING, y + PADDING, width - (PADDING * 2), question_h + PADDING),
                       GTextOverflowModeWordWrap, GTextAlignmentLeft, NULL);
  }
  y += question_h + PADDING * 2;
  if (draw) {
    draw_divider(ctx, PADDING, y, width - (PADDING * 2), COLOR_DIM, true);
  }
  y += DIVIDER_GAP;

  // Options
  for (int i = 0; i < s_choice_option_count; i++) {
    bool selected = (i == s_choice_selection);
    int16_t opt_h = measure_text_height(s_choice_options[i], option_font, width - (PADDING * 4));
    if (opt_h < ROW_HEIGHT) {
      opt_h = ROW_HEIGHT;
    }

    if (draw) {
      if (selected) {
        graphics_context_set_fill_color(ctx, ACCENT_SELECT);
        graphics_fill_rect(ctx, GRect(0, y, width, opt_h), 0, GCornerNone);
      }
      GColor text_color = selected ? GColorWhite : GColorBlack;
      graphics_context_set_text_color(ctx, text_color);
      graphics_draw_text(ctx, s_choice_options[i], option_font,
                         GRect(PADDING * 2, y + 4, width - (PADDING * 4), opt_h),
                         GTextOverflowModeWordWrap, GTextAlignmentLeft, NULL);
    }
    y += opt_h;
  }

  if (draw) {
    graphics_context_set_text_color(ctx, COLOR_DIM);
    graphics_draw_text(ctx, "SELECT pick  UP/DN move  BACK", hint_font,
                       GRect(PADDING, y + PADDING, width - (PADDING * 2), 20),
                       GTextOverflowModeWordWrap, GTextAlignmentLeft, NULL);
  }
  y += 20 + PADDING * 2;

  return y;
}

static void choice_layer_update_proc(Layer *layer, GContext *ctx) {
  layout_choice_text(ctx, layer_get_bounds(layer), true);
}

static void send_simple_command(uint32_t key, const char *failure_status) {
  DictionaryIterator *iter;
  AppMessageResult result = app_message_outbox_begin(&iter);
  if (result != APP_MSG_OK || !iter) {
    update_display(failure_status);
    vibes_double_pulse();
    return;
  }

  dict_write_uint8(iter, key, 1);
  dict_write_end(iter);
  result = app_message_outbox_send();
  if (result != APP_MSG_OK) {
    update_display(failure_status);
    vibes_double_pulse();
  }
}

static void clear_watch_session(void) {
  s_last_prompt[0] = '\0';
  s_assistant_response[0] = '\0';
  s_chat_history[0] = '\0';
  s_current_ai_response_start = NULL;
  s_show_home = true;
  s_request_active = false;
  s_response_started = false;
  vibes_short_pulse();
  update_display("New session");
}

//AI: Append text to the session transcript without overflowing the fixed buffer.
static void append_chat_history(const char *text) {
  size_t current_len = strlen(s_chat_history);
  size_t remaining = sizeof(s_chat_history) - current_len - 1;
  if (remaining > 0) {
    strncat(s_chat_history, text, remaining);
  }
}

//AI: Configure a small label layer like Bobby's speaker labels.
static void configure_label_layer(TextLayer *layer, const char *text) {
  text_layer_set_text(layer, text);
  text_layer_set_font(layer, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
  text_layer_set_text_color(layer, GColorBlack);
  text_layer_set_background_color(layer, GColorClear);
}

//AI: Configure a larger message body layer.
static void configure_message_layer(TextLayer *layer) {
  text_layer_set_font(layer, fonts_get_system_font(FONT_KEY_GOTHIC_24));
  text_layer_set_text_color(layer, GColorBlack);
  text_layer_set_background_color(layer, GColorClear);
  text_layer_set_overflow_mode(layer, GTextOverflowModeWordWrap);
}

//AI: Draw the idle home screen with a branded title, usage/model stats, and bottom hints.
static void home_layer_update_proc(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);
  int16_t width = bounds.size.w;
  int16_t text_width = width - (PADDING * 2);
  int16_t y = PADDING;

  GFont title_font = fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD);
  GFont stats_font = fonts_get_system_font(FONT_KEY_GOTHIC_24);
  GFont hint_font = fonts_get_system_font(FONT_KEY_GOTHIC_14);

  graphics_context_set_text_color(ctx, ACCENT_AI);
  int16_t title_h = measure_text_height("Pebble AI", title_font, text_width);
  graphics_draw_text(ctx, "Pebble AI", title_font, GRect(PADDING, y, text_width, title_h + 2),
                     GTextOverflowModeWordWrap, GTextAlignmentLeft, NULL);
  y += title_h + 3;

  draw_divider(ctx, PADDING, y, text_width, ACCENT_AI, true);
  y += DIVIDER_GAP + PADDING;

  const char *stats = s_stats_text[0] ? s_stats_text : "Loading stats...";
  graphics_context_set_text_color(ctx, GColorBlack);
  graphics_draw_text(ctx, stats, stats_font, GRect(PADDING, y, text_width, bounds.size.h - y),
                     GTextOverflowModeWordWrap, GTextAlignmentLeft, NULL);

  int16_t hint_h = measure_text_height("SELECT speak  UP tools  DOWN sessions", hint_font, text_width);
  int16_t hint_y = bounds.size.h - hint_h - PADDING;
  if (hint_y > y) {
    graphics_context_set_text_color(ctx, COLOR_DIM);
    graphics_draw_text(ctx, "SELECT speak  UP tools  DOWN sessions", hint_font,
                       GRect(PADDING, hint_y, text_width, hint_h + 2),
                       GTextOverflowModeWordWrap, GTextAlignmentCenter, NULL);
  }
}

//AI: Return true for transcript speaker-name lines that should be drawn in bold.
static bool is_history_label(const char *line) {
  return strcmp(line, "You") == 0 || strcmp(line, "AI") == 0 || strcmp(line, "Error") == 0;
}

static GColor history_label_color(const char *line) {
  if (strcmp(line, "You") == 0) {
    return ACCENT_USER;
  }
  if (strcmp(line, "Error") == 0) {
    return ACCENT_ERROR;
  }
  return ACCENT_AI;
}

//AI: Measure or draw the transcript turn by turn with colored speaker badges and dividers.
static int16_t layout_history_text(GContext *ctx, GRect bounds, bool draw) {
  GFont badge_font = fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD);
  GFont body_font = fonts_get_system_font(FONT_KEY_GOTHIC_24);
  int16_t width = bounds.size.w;
  int16_t y = 0;
  char *line = s_chat_history;
  bool first_turn = true;

  while (line && *line) {
    char *next = strchr(line, '\n');
    if (next) {
      *next = '\0';
    }

    if (line[0] != '\0') {
      bool is_label = is_history_label(line);
      if (is_label) {
        if (!first_turn) {
          if (strcmp(line, "You") == 0) {
            draw_divider(ctx, PADDING, y + 1, width - (PADDING * 2), COLOR_DIM, draw);
            y += DIVIDER_GAP + PADDING;
          } else {
            y += PADDING * 3;
          }
        }
        first_turn = false;
        GColor fill = history_label_color(line);
        int16_t badge_h = draw_badge(ctx, PADDING, y, width - (PADDING * 2), line, fill, badge_font, draw);
        y += badge_h;
      } else {
        int16_t body_h = measure_text_height(line, body_font, width - (PADDING * 2));
        if (draw) {
          graphics_context_set_text_color(ctx, GColorBlack);
          graphics_draw_text(ctx, line, body_font, GRect(PADDING, y, width - (PADDING * 2), body_h + PADDING),
                             GTextOverflowModeWordWrap, GTextAlignmentLeft, NULL);
        }
        y += body_h + PADDING;
      }
    }

    if (next) {
      *next = '\n';
      line = next + 1;
    } else {
      break;
    }
  }

  return y + PADDING;
}

//AI: Custom transcript layer update procedure, needed because TextLayer cannot mix bold and normal text.
static void history_layer_update_proc(Layer *layer, GContext *ctx) {
  layout_history_text(ctx, layer_get_bounds(layer), true);
}

//AI: Resize one message TextLayer to fit its current text and return its height.
static int16_t resize_text_layer(TextLayer *layer, int16_t y, int16_t width) {
  int16_t text_width = width - (PADDING * 2);
  GFont font = fonts_get_system_font(FONT_KEY_GOTHIC_24);
  const char *text = text_layer_get_text(layer);
  GRect measure_rect = GRect(0, 0, text_width, TEXT_MEASURE_HEIGHT);
  GSize size = graphics_text_layout_get_content_size(text ? text : "", font, measure_rect,
                                                     GTextOverflowModeWordWrap, GTextAlignmentLeft);
  int16_t height = size.h + PADDING;
  layer_set_frame(text_layer_get_layer(layer), GRect(PADDING, y, text_width, height));
  text_layer_set_size(layer, GSize(text_width, height));
  return height;
}

//AI: Bobby uses separate stacked segments; this lays out our minimal prompt/assistant segments.
static void layout_chat(bool scroll_to_bottom) {
  if (!s_scroll_layer || !s_prompt_layer || !s_assistant_layer) {
    return;
  }

  Layer *scroll_root = scroll_layer_get_layer(s_scroll_layer);
  GRect bounds = layer_get_bounds(scroll_root);
  int16_t width = bounds.size.w;
  int16_t y = PADDING;

  bool has_response = s_assistant_response[0] != '\0';
  bool has_history = s_chat_history[0] != '\0';
  bool show_status_message = strcmp(s_status_text, "Ready") != 0 && strcmp(s_status_text, "Done") != 0 && !has_response;

  layer_set_hidden(s_home_layer, s_show_settings || s_show_sessions || !s_show_home || show_status_message);
  layer_set_hidden(s_history_layer, s_show_settings || s_show_sessions || s_show_home || !has_history);
  layer_set_hidden(s_settings_layer, !s_show_settings);
  layer_set_hidden(s_sessions_layer, !s_show_sessions);
  layer_set_hidden(s_choice_layer, !s_show_choice);
  layer_set_hidden(text_layer_get_layer(s_prompt_label_layer), true);
  layer_set_hidden(text_layer_get_layer(s_prompt_layer), true);
  layer_set_hidden(text_layer_get_layer(s_assistant_label_layer), true);
  layer_set_hidden(text_layer_get_layer(s_assistant_layer), true);
  layer_set_hidden(text_layer_get_layer(s_status_message_layer), !show_status_message);

  if (s_show_settings) {
    int16_t settings_height = layout_settings_text(NULL, GRect(0, 0, width, TEXT_MEASURE_HEIGHT), false);
    layer_set_frame(s_settings_layer, GRect(0, y, width, settings_height));
    layer_mark_dirty(s_settings_layer);
    y += settings_height;
  }

  if (s_show_sessions) {
    int16_t sessions_height = layout_sessions_text(NULL, GRect(0, 0, width, TEXT_MEASURE_HEIGHT), false);
    layer_set_frame(s_sessions_layer, GRect(0, y, width, sessions_height));
    layer_mark_dirty(s_sessions_layer);
    y += sessions_height;
  }

  if (!s_show_settings && !s_show_sessions && !s_show_home && has_history) {
    int16_t history_height = layout_history_text(NULL, GRect(0, 0, width, TEXT_MEASURE_HEIGHT), false);
    layer_set_frame(s_history_layer, GRect(0, y, width, history_height));
    layer_mark_dirty(s_history_layer);
    y += history_height;
  }

  if (show_status_message) {
    y += PADDING;
    text_layer_set_text(s_status_message_layer, s_status_text);
    y += resize_text_layer(s_status_message_layer, y, width);
  }

  int16_t content_height;
  if (s_show_settings || s_show_sessions || (!s_show_home && has_history) || show_status_message) {
    content_height = y + PADDING;
  } else {
    int16_t text_width = width - (PADDING * 2);
    const char *stats = s_stats_text[0] ? s_stats_text : "Loading stats...";
    int16_t title_h = measure_text_height("Pebble AI", fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD), text_width);
    GSize stats_size = graphics_text_layout_get_content_size(stats,
                                                             fonts_get_system_font(FONT_KEY_GOTHIC_24),
                                                             GRect(0, 0, text_width, TEXT_MEASURE_HEIGHT),
                                                             GTextOverflowModeWordWrap, GTextAlignmentLeft);
    int16_t hint_h = measure_text_height("SELECT speak  UP tools  DOWN sessions",
                                         fonts_get_system_font(FONT_KEY_GOTHIC_14), text_width);
    int16_t home_height = PADDING + (title_h + 3) + DIVIDER_GAP + PADDING + stats_size.h + PADDING + hint_h + PADDING;
    content_height = home_height > bounds.size.h ? home_height : bounds.size.h;
    layer_set_frame(s_home_layer, GRect(0, 0, width, content_height));
    layer_mark_dirty(s_home_layer);
  }
  scroll_layer_set_content_size(s_scroll_layer, GSize(width, content_height));

  if (scroll_to_bottom && content_height > bounds.size.h) {
    scroll_layer_set_content_offset(s_scroll_layer, GPoint(0, -(content_height - bounds.size.h)), false);
  }
}

// Long assistant replies arrive from the phone as multiple AppMessage chunks.
static void append_response_chunk(const char *chunk) {
  // Find out how much space is left so we do not overflow the response buffer.
  size_t current_len = strlen(s_assistant_response);
  size_t remaining = sizeof(s_assistant_response) - current_len - 1;
  if (remaining > 0) {
    strncat(s_assistant_response, chunk, remaining);
  }
}

// Rebuild the full screen text whenever prompt, status, or response changes.
static void update_display(const char *status) {
  //AI: The status is shown in the top status bar, while messages live in the scroll layer.
  snprintf(s_status_text, sizeof(s_status_text), "%s", status ? status : "Ready");
  status_bar_layer_set_separator_mode(s_status_layer, StatusBarLayerSeparatorModeDotted);
  status_bar_layer_set_colors(s_status_layer, GColorWhite, GColorBlack);
  text_layer_set_text(s_prompt_layer, s_last_prompt);
  text_layer_set_text(s_assistant_layer, s_assistant_response);
  layout_chat(true);
}

// Send the user's dictated text to PebbleKit JS on the phone.
static void send_prompt(const char *prompt) {
  // Ignore empty prompts so we do not send meaningless AppMessages.
  if (!prompt || !prompt[0]) {
    update_display("Nothing to send");
    return;
  }

  // If a request is still running, cancel it so responses don't interleave.
  if (s_request_active) {
    send_simple_command(MESSAGE_KEY_CancelRequest, "Cancel failed");
  }

  // Store the latest prompt locally and clear the previous assistant reply.
  snprintf(s_last_prompt, sizeof(s_last_prompt), "%s", prompt);
  s_assistant_response[0] = '\0';
  s_show_home = false;
  s_request_active = true;
  s_response_started = false;
  if (s_chat_history[0] != '\0') {
    append_chat_history("\n\n");
  }
  append_chat_history("You\n");
  append_chat_history(s_last_prompt);
  append_chat_history("\n\nAI\n");
  s_current_ai_response_start = s_chat_history + strlen(s_chat_history);
  update_display("Sending...");

  // Start building an outgoing AppMessage dictionary.
  DictionaryIterator *iter;
  AppMessageResult result = app_message_outbox_begin(&iter);
  if (result != APP_MSG_OK || !iter) {
    s_request_active = false;
    update_display("Phone not ready");
    return;
  }

  // Put the prompt into the message under the Prompt key, then send it.
  dict_write_cstring(iter, MESSAGE_KEY_Prompt, s_last_prompt);
  dict_write_end(iter);
  result = app_message_outbox_send();
  if (result != APP_MSG_OK) {
    s_request_active = false;
    update_display("Send failed");
    vibes_double_pulse();
  }
}

// Receive status, errors, and response chunks from PebbleKit JS.
static void inbox_received_callback(DictionaryIterator *iter, void *context) {
  //USR: Define suff...
  //AI: Look up any known fields that may be present in this incoming AppMessage.
  Tuple *status_tuple = dict_find(iter, MESSAGE_KEY_Status);
  Tuple *response_tuple = dict_find(iter, MESSAGE_KEY_AssistantResponse);
  Tuple *chunk_index_tuple = dict_find(iter, MESSAGE_KEY_ResponseChunkIndex);
  Tuple *chunk_done_tuple = dict_find(iter, MESSAGE_KEY_ResponseChunkDone);
  Tuple *stats_tuple = dict_find(iter, MESSAGE_KEY_StatsText);
  Tuple *tool_states_tuple = dict_find(iter, MESSAGE_KEY_ToolStates);
  Tuple *error_tuple = dict_find(iter, MESSAGE_KEY_Error);

  //USR: Default status to Ready. if status_tuple- is set, then use that for status (as a string?)
  //AI: Default to "Ready" unless the phone sent a different status string.
  const char *status = "Ready";
  if (status_tuple) {
    status = status_tuple->value->cstring;
    //AI: When a tool is running, reset the response flag so the real answer vibrates later.
    if (strcmp(status, "Searching...") == 0 || strcmp(status, "Scraping...") == 0 ||
        strcmp(status, "Calculating...") == 0 || strcmp(status, "Getting weather...") == 0 ||
        strcmp(status, "Getting location...") == 0) {
      s_response_started = false;
    }
  }

  //USR: if response_tuple is true do:
  //AI: If the message includes assistant text, process it.
  if (response_tuple) {
    //USR: se if AI respnse
    //AI: A chunk index means the reply is arriving in multiple AppMessages.
    if (chunk_index_tuple) {
      //USR: Yes, se if first word??
      //AI: Chunk 0 starts a new reply, so clear the previous response first.
      if (chunk_index_tuple->value->int32 == 0) {
        s_assistant_response[0] = '\0';
        if (s_current_ai_response_start) {
          *s_current_ai_response_start = '\0';
        }
      }
      //USR: else add to rest of response
      //AI: Add this chunk's text onto the full assistant response buffer.
      append_response_chunk(response_tuple->value->cstring);
      append_chat_history(response_tuple->value->cstring);
      if (!s_response_started) {
        s_response_started = true;
        vibes_short_pulse();
      }
    } else {
      //USR: Else do normal start screen with status
      //AI: No chunk index means this is a complete one-piece response, so replace the old text.
      snprintf(s_assistant_response, sizeof(s_assistant_response), "%s", response_tuple->value->cstring);
      append_chat_history(response_tuple->value->cstring);
      if (!s_response_started) {
        s_response_started = true;
        vibes_short_pulse();
      }
    }
  }

  //USR: If error, print error
  //AI: If the phone sent an error, show it in place of the assistant response and mark status as Error.
  if (error_tuple) {
    snprintf(s_assistant_response, sizeof(s_assistant_response), "%s", error_tuple->value->cstring);
    append_chat_history("\nError\n");
    append_chat_history(error_tuple->value->cstring);
    status = "Error";
    s_request_active = false;
    vibes_double_pulse();
  } else if (chunk_done_tuple && chunk_done_tuple->value->int32 == 1) {
    s_request_active = false;
    vibes_double_pulse();
  }

  if (status_tuple && strcmp(status, "Cancelled") == 0) {
    s_request_active = false;
  } else if (status_tuple && (strcmp(status, "Location on") == 0 || strcmp(status, "Location off") == 0 ||
                              strcmp(status, "Memory on") == 0 || strcmp(status, "Memory off") == 0 ||
                              strcmp(status, "Calculator on") == 0 || strcmp(status, "Calculator off") == 0 ||
                              strcmp(status, "Search on") == 0 || strcmp(status, "Search off") == 0 ||
                              strcmp(status, "Weather on") == 0 || strcmp(status, "Weather off") == 0)) {
    vibes_short_pulse();
    status = "Ready";
  }

  if (stats_tuple) {
    snprintf(s_stats_text, sizeof(s_stats_text), "%s", stats_tuple->value->cstring);
    layer_mark_dirty(s_home_layer);
  }

  if (tool_states_tuple) {
    const char *states = tool_states_tuple->value->cstring;
    s_location_enabled = strstr(states, "location=1") != NULL;
    s_memory_enabled = strstr(states, "memory=1") != NULL;
    s_calculator_enabled = strstr(states, "calculator=1") != NULL;
    s_search_enabled = strstr(states, "search=1") != NULL;
    s_weather_enabled = strstr(states, "weather=1") != NULL;
    s_choice_enabled = strstr(states, "choice=1") != NULL;
    if (s_show_settings) {
      layer_mark_dirty(s_settings_layer);
    }
  }

  {
    Tuple *sessions_tuple = dict_find(iter, MESSAGE_KEY_OpenSessions);
    if (sessions_tuple) {
      snprintf(s_sessions_text, sizeof(s_sessions_text), "%s", sessions_tuple->value->cstring);
      if (s_show_sessions) {
        update_display("Ready");
      }
    }
  }

  {
    Tuple *choice_question_tuple = dict_find(iter, MESSAGE_KEY_ChoiceQuestion);
    Tuple *choice_options_tuple = dict_find(iter, MESSAGE_KEY_ChoiceOptions);
    if (choice_question_tuple && choice_options_tuple) {
      open_choice_screen(choice_question_tuple->value->cstring, choice_options_tuple->value->cstring);
    }
  }

  {
    Tuple *choice_cancel_tuple = dict_find(iter, MESSAGE_KEY_ChoiceCancel);
    if (choice_cancel_tuple) {
      close_choice_screen();
    }
  }

  //USR: Update text/display with new info
  //AI: Rebuild and redraw the watch text view using the latest status and response.
  update_display(status);
}

// Pebble dictation calls this after speech recognition succeeds or fails.
//USR: If user has finished their dictation, then send it to the Phone, else update the display with a "Dictation cancelled"
//AI: If speech recognition succeeded, send the transcription to the phone; otherwise show "Dictation cancelled".
static void dictation_callback(DictationSession *session, DictationSessionStatus status,
                               char *transcription, void *context) {
  if (s_choice_waiting_dictation) {
    s_choice_waiting_dictation = false;
    if (status == DictationSessionStatusSuccess) {
      DictionaryIterator *iter;
      AppMessageResult result = app_message_outbox_begin(&iter);
      if (result == APP_MSG_OK && iter) {
        dict_write_cstring(iter, MESSAGE_KEY_ChoiceAnswer, transcription);
        dict_write_end(iter);
        app_message_outbox_send();
      }
      close_choice_screen();
      s_show_home = false;
      update_display("Sending...");
    }
    // On cancel, leave the choice screen open so user can try again/back
    return;
  }

  if (status == DictationSessionStatusSuccess) {
    // Forward the recognized speech to the phone-side JS for AI processing.
    send_prompt(transcription);
  } else {
    s_show_home = true;
    update_display("Ready");
  }
}

// SELECT is the only app-specific button action; UP/DOWN are kept for scrolling.
static void select_click_handler(ClickRecognizerRef recognizer, void *context) {
  if (s_show_choice) {
    if (s_choice_selection >= 0 && s_choice_selection < s_choice_option_count) {
      if (strcmp(s_choice_options[s_choice_selection], "Say your own") == 0) {
        s_choice_waiting_dictation = true;
        dictation_session_start(s_dictation_session);
      } else {
        send_choice_answer();
      }
    }
    return;
  }

  if (s_show_settings) {
    toggle_selected_setting();
    return;
  }

  // Ask Pebble to show its dictation UI and start listening to the microphone.
  dictation_session_start(s_dictation_session);
}

static void select_long_click_handler(ClickRecognizerRef recognizer, void *context) {
  if (s_show_choice) {
    return;
  }
  clear_watch_session();

  send_simple_command(MESSAGE_KEY_ClearSession, "Cleared watch only");
}

static void back_click_handler(ClickRecognizerRef recognizer, void *context) {
  if (s_show_choice) {
    DictionaryIterator *iter;
    AppMessageResult result = app_message_outbox_begin(&iter);
    if (result == APP_MSG_OK && iter) {
      dict_write_uint8(iter, MESSAGE_KEY_ChoiceCancel, 1);
      dict_write_end(iter);
      app_message_outbox_send();
    }
    close_choice_screen();
    return;
  }

  if (s_show_settings) {
    s_show_settings = false;
    s_show_home = s_settings_return_home;
    update_display("Ready");
    return;
  }

  if (s_show_sessions) {
    s_show_sessions = false;
    s_show_home = s_settings_return_home;
    update_display("Ready");
    return;
  }

  if (s_request_active) {
    s_request_active = false;
    update_display("Cancelling...");
    send_simple_command(MESSAGE_KEY_CancelRequest, "Cancel failed");
    return;
  }

  if (!s_show_home) {
    s_show_home = true;
    update_display("Ready");
    return;
  }

  window_stack_pop(true);
}

static void up_long_click_handler(ClickRecognizerRef recognizer, void *context) {
  if (s_show_choice) {
    return;
  }
  open_settings_screen();
}

static void down_long_click_handler(ClickRecognizerRef recognizer, void *context) {
  if (s_show_choice) {
    return;
  }
  open_sessions_screen();
}

static void up_click_handler(ClickRecognizerRef recognizer, void *context) {
  if (s_show_choice) {
    s_choice_selection = (s_choice_selection + s_choice_option_count - 1) % s_choice_option_count;
    layer_mark_dirty(s_choice_layer);
    return;
  }

  if (s_show_settings) {
    s_settings_selection = (s_settings_selection + 5) % 6;
    update_display("Ready");
  } else if (s_show_home) {
    open_settings_screen();
  } else {
    scroll_layer_set_content_offset(s_scroll_layer,
                                    GPoint(0, scroll_layer_get_content_offset(s_scroll_layer).y + 40), false);
  }
}

static void down_click_handler(ClickRecognizerRef recognizer, void *context) {
  if (s_show_choice) {
    s_choice_selection = (s_choice_selection + 1) % s_choice_option_count;
    layer_mark_dirty(s_choice_layer);
    return;
  }

  if (s_show_settings) {
    s_settings_selection = (s_settings_selection + 1) % 6;
    update_display("Ready");
  } else if (s_show_home) {
    open_sessions_screen();
  } else {
    scroll_layer_set_content_offset(s_scroll_layer,
                                    GPoint(0, scroll_layer_get_content_offset(s_scroll_layer).y - 40), false);
  }
}

static void toggle_selected_setting(void) {
  switch (s_settings_selection) {
    case 0:
      send_simple_command(MESSAGE_KEY_ToggleLocation, "Toggle failed");
      break;
    case 1:
      send_simple_command(MESSAGE_KEY_ToggleMemory, "Toggle failed");
      break;
    case 2:
      send_simple_command(MESSAGE_KEY_ToggleCalculator, "Toggle failed");
      break;
    case 3:
      send_simple_command(MESSAGE_KEY_ToggleSearch, "Toggle failed");
      break;
    case 4:
      send_simple_command(MESSAGE_KEY_ToggleWeather, "Toggle failed");
      break;
    case 5:
      send_simple_command(MESSAGE_KEY_ToggleChoice, "Toggle failed");
      break;
  }
}

#ifdef _PBL_API_EXISTS_touch_service_subscribe
static void touch_long_timer_callback(void *context) {
  s_touch_long_timer = NULL;
  if (!s_touch_moved) {
    s_touch_long_fired = true;
    clear_watch_session();
    send_simple_command(MESSAGE_KEY_ClearSession, "Cleared watch only");
  }
}

static void scroll_by_delta(int16_t delta_y) {
  GSize content_size = scroll_layer_get_content_size(s_scroll_layer);
  GRect bounds = layer_get_bounds(scroll_layer_get_layer(s_scroll_layer));
  GPoint offset = scroll_layer_get_content_offset(s_scroll_layer);
  int16_t min_y = bounds.size.h - content_size.h;

  if (min_y > 0) {
    min_y = 0;
  }

  offset.y += delta_y;
  if (offset.y > 0) {
    offset.y = 0;
  } else if (offset.y < min_y) {
    offset.y = min_y;
  }

  scroll_layer_set_content_offset(s_scroll_layer, offset, false);
}

static void touch_handler(const TouchEvent *event, void *context) {
  switch (event->type) {
    case TouchEvent_Touchdown:
      s_touch_start_y = event->y;
      s_touch_last_y = event->y;
      s_touch_moved = false;
      s_touch_long_fired = false;
      if (s_touch_long_timer) {
        app_timer_cancel(s_touch_long_timer);
      }
      s_touch_long_timer = app_timer_register(700, touch_long_timer_callback, NULL);
      break;

    case TouchEvent_PositionUpdate: {
      int16_t delta_from_start = event->y - s_touch_start_y;
      int16_t delta = event->y - s_touch_last_y;
      if (delta_from_start > 8 || delta_from_start < -8) {
        s_touch_moved = true;
        if (s_touch_long_timer) {
          app_timer_cancel(s_touch_long_timer);
          s_touch_long_timer = NULL;
        }
      }
      scroll_by_delta(delta);
      s_touch_last_y = event->y;
      break;
    }

    case TouchEvent_Liftoff:
      if (s_touch_long_timer) {
        app_timer_cancel(s_touch_long_timer);
        s_touch_long_timer = NULL;
      }
      break;
  }
}
#endif

// The ScrollLayer installs UP/DOWN scrolling, then calls this so SELECT can be added.
static void scroll_click_config_provider(void *context) {
  // Bind the SELECT button to our custom handler.
  window_single_click_subscribe(BUTTON_ID_BACK, back_click_handler);
  window_single_click_subscribe(BUTTON_ID_UP, up_click_handler);
  window_single_click_subscribe(BUTTON_ID_DOWN, down_click_handler);
  window_single_click_subscribe(BUTTON_ID_SELECT, select_click_handler);
  window_long_click_subscribe(BUTTON_ID_SELECT, 700, select_long_click_handler, NULL);
  window_long_click_subscribe(BUTTON_ID_UP, 700, up_long_click_handler, NULL);
  window_long_click_subscribe(BUTTON_ID_DOWN, 700, down_long_click_handler, NULL);
}

// Create the plain scrollable text UI.
static void window_load(Window *window) {
  // Get the root layer and its bounds so child layers can be sized to fill the screen.
  Layer *window_layer = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(window_layer);

  //AI: Add a top status bar like Bobby's session screen.
  s_status_layer = status_bar_layer_create();
  status_bar_layer_set_colors(s_status_layer, GColorWhite, GColorBlack);
  status_bar_layer_set_separator_mode(s_status_layer, StatusBarLayerSeparatorModeDotted);
  layer_add_child(window_layer, status_bar_layer_get_layer(s_status_layer));

  //AI: The bottom layer is used by Pebble's content indicator to show more content below.
  s_scroll_indicator_down = layer_create(GRect(0, bounds.size.h - STATUS_BAR_LAYER_HEIGHT, bounds.size.w, STATUS_BAR_LAYER_HEIGHT));

  // Create a ScrollLayer so long responses can be read with UP/DOWN.
  s_scroll_layer = scroll_layer_create(GRect(0, STATUS_BAR_LAYER_HEIGHT, bounds.size.w, bounds.size.h - STATUS_BAR_LAYER_HEIGHT));
  scroll_layer_set_shadow_hidden(s_scroll_layer, true);
  scroll_layer_set_callbacks(s_scroll_layer, (ScrollLayerCallbacks) {
    .click_config_provider = scroll_click_config_provider
  });
  scroll_layer_set_click_config_onto_window(s_scroll_layer, window);
  layer_add_child(window_layer, scroll_layer_get_layer(s_scroll_layer));

  //AI: Configure Bobby-like up/down scroll indicators in the status and bottom indicator layers.
  ContentIndicator *indicator = scroll_layer_get_content_indicator(s_scroll_layer);
  ContentIndicatorConfig up_config = (ContentIndicatorConfig) {
    .layer = status_bar_layer_get_layer(s_status_layer),
    .times_out = true,
    .alignment = GAlignCenter,
    .colors = { .foreground = GColorBlack, .background = GColorWhite }
  };
  content_indicator_configure_direction(indicator, ContentIndicatorDirectionUp, &up_config);
  ContentIndicatorConfig down_config = (ContentIndicatorConfig) {
    .layer = s_scroll_indicator_down,
    .times_out = true,
    .alignment = GAlignCenter,
    .colors = { .foreground = GColorBlack, .background = GColorWhite }
  };
  content_indicator_configure_direction(indicator, ContentIndicatorDirectionDown, &down_config);

  //AI: Create separate label/body layers instead of one giant text blob.
  s_prompt_label_layer = text_layer_create(GRectZero);
  configure_label_layer(s_prompt_label_layer, "You");
  scroll_layer_add_child(s_scroll_layer, text_layer_get_layer(s_prompt_label_layer));

  s_prompt_layer = text_layer_create(GRectZero);
  configure_message_layer(s_prompt_layer);
  scroll_layer_add_child(s_scroll_layer, text_layer_get_layer(s_prompt_layer));

  s_assistant_label_layer = text_layer_create(GRectZero);
  configure_label_layer(s_assistant_label_layer, "Assistant");
  scroll_layer_add_child(s_scroll_layer, text_layer_get_layer(s_assistant_label_layer));

  s_assistant_layer = text_layer_create(GRectZero);
  configure_message_layer(s_assistant_layer);
  scroll_layer_add_child(s_scroll_layer, text_layer_get_layer(s_assistant_layer));

  s_history_layer = layer_create(GRectZero);
  layer_set_update_proc(s_history_layer, history_layer_update_proc);
  scroll_layer_add_child(s_scroll_layer, s_history_layer);

  s_home_layer = layer_create(GRect(0, 0, bounds.size.w, bounds.size.h - STATUS_BAR_LAYER_HEIGHT));
  layer_set_update_proc(s_home_layer, home_layer_update_proc);
  scroll_layer_add_child(s_scroll_layer, s_home_layer);

  s_status_message_layer = text_layer_create(GRectZero);
  configure_message_layer(s_status_message_layer);
  text_layer_set_text_color(s_status_message_layer, GColorDarkGray);
  scroll_layer_add_child(s_scroll_layer, text_layer_get_layer(s_status_message_layer));

  s_settings_layer = layer_create(GRectZero);
  layer_set_update_proc(s_settings_layer, settings_layer_update_proc);
  scroll_layer_add_child(s_scroll_layer, s_settings_layer);

  s_sessions_layer = layer_create(GRectZero);
  layer_set_update_proc(s_sessions_layer, sessions_layer_update_proc);
  scroll_layer_add_child(s_scroll_layer, s_sessions_layer);

  s_choice_layer = layer_create(GRect(0, STATUS_BAR_LAYER_HEIGHT, bounds.size.w, bounds.size.h - STATUS_BAR_LAYER_HEIGHT));
  layer_set_update_proc(s_choice_layer, choice_layer_update_proc);
  layer_add_child(window_layer, s_choice_layer);
  layer_set_hidden(s_choice_layer, true);

  //AI: This must be added after the scroll layer so the down indicator appears on top.
  layer_add_child(window_layer, s_scroll_indicator_down);

  // Show the initial idle screen.
  update_display("Ready");
}

//AI: Quick launch should behave like Bobby: open the app and immediately start listening.
static void window_appear(Window *window) {
#ifdef _PBL_API_EXISTS_touch_service_subscribe
  touch_service_subscribe(touch_handler, NULL);
#endif

  if (s_start_dictation_on_appear) {
    s_start_dictation_on_appear = false;
    dictation_session_start(s_dictation_session);
  }
}

static void window_disappear(Window *window) {
#ifdef _PBL_API_EXISTS_touch_service_subscribe
  if (s_touch_long_timer) {
    app_timer_cancel(s_touch_long_timer);
    s_touch_long_timer = NULL;
  }
  touch_service_unsubscribe();
#endif
}

// Destroy UI objects created in window_load().
static void window_unload(Window *window) {
  // These objects were heap-allocated in window_load(), so they must be destroyed here.
  text_layer_destroy(s_prompt_label_layer);
  text_layer_destroy(s_prompt_layer);
  text_layer_destroy(s_assistant_label_layer);
  text_layer_destroy(s_assistant_layer);
  layer_destroy(s_history_layer);
  layer_destroy(s_home_layer);
  text_layer_destroy(s_status_message_layer);
  layer_destroy(s_settings_layer);
  layer_destroy(s_sessions_layer);
  layer_destroy(s_choice_layer);
  status_bar_layer_destroy(s_status_layer);
  layer_destroy(s_scroll_indicator_down);
  scroll_layer_destroy(s_scroll_layer);
}

// App setup: create the window, open AppMessage, and create dictation.
static void init(void) {
  s_window = window_create(); //USR: Create window and call it s_window
  //AI: Creates a Window object and stores its pointer in s_window.
  window_set_window_handlers(s_window, (WindowHandlers) { //USR: something with the scroll layer?
    //AI: Register which functions Pebble should call when this window loads and unloads.
    .load = window_load,
    .appear = window_appear,
    .disappear = window_disappear,
    .unload = window_unload
  });

  app_message_register_inbox_received(inbox_received_callback); //USR: IDK, something with the AppMessage?
  //AI: Register the function that should run when a message arrives from the phone.
  app_message_open(4096, 2048); //USR: AGAIN, something with the AppMessage?
  //AI: Open AppMessage with a 4096-byte inbox and a 2048-byte outbox.

  s_dictation_session = dictation_session_create(DICTATION_BUFFER_SIZE, dictation_callback, NULL); //USR: Start the dictation deamon? with a buffersize?
  //AI: Create a dictation session; Pebble will call dictation_callback when speech recognition finishes.
  dictation_session_enable_confirmation(s_dictation_session, false); // Purposly set to false

  s_start_dictation_on_appear = launch_reason() == APP_LAUNCH_QUICK_LAUNCH;
  window_stack_push(s_window, true); //USR: Make our window appear on the screen
  //AI: Push the window onto Pebble's window stack so it appears on screen, with animation.
}

// Release resources before the app exits.
static void deinit(void) {
  // Tear down runtime objects created during init().
  dictation_session_destroy(s_dictation_session);
  window_destroy(s_window);
}

int main(void) {
  // Set up the app's objects and message handlers.
  init();
  // Hand control to Pebble so it can dispatch button, dictation, and AppMessage events.
  app_event_loop();
  // Clean up after the event loop exits, usually when the app is closing.
  deinit();
}
