#include <pebble.h>

//AI: Small spacing values used to lay out the Bobby-like stacked chat view.
#define PADDING 5
#define LABEL_HEIGHT 24
#define TEXT_MEASURE_HEIGHT 12000

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
static TextLayer *s_settings_layer;
static Layer *s_sessions_layer;
static TextLayer *s_empty_layer;
static DictationSession *s_dictation_session;

// These buffers hold the current conversation state shown in the single text view.
static char s_last_prompt[DICTATION_BUFFER_SIZE];
static char s_assistant_response[RESPONSE_BUFFER_SIZE];
static char s_chat_history[CHAT_HISTORY_BUFFER_SIZE];
static char s_status_text[64];
static char s_stats_text[STATS_BUFFER_SIZE];
static char s_sessions_text[1600];
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
#ifdef _PBL_API_EXISTS_touch_service_subscribe
static AppTimer *s_touch_long_timer;
static bool s_touch_long_fired;
static bool s_touch_moved;
static int16_t s_touch_start_y;
static int16_t s_touch_last_y;
#endif

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

static int16_t layout_sessions_text(GContext *ctx, GRect bounds, bool draw) {
  GFont header_font = fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD);
  GFont label_font = fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD);
  GFont body_font = fonts_get_system_font(FONT_KEY_GOTHIC_24);
  int16_t y = 0;
  char *line = s_sessions_text;

  while (line && *line) {
    char *next = strchr(line, '\n');
    if (next) {
      *next = '\0';
    }

    if (line[0] != '\0') {
      if (is_session_header(line)) {
        GRect measure_rect = GRect(0, 0, bounds.size.w, TEXT_MEASURE_HEIGHT);
        GSize size = graphics_text_layout_get_content_size(line, header_font, measure_rect,
                                                           GTextOverflowModeWordWrap, GTextAlignmentLeft);
        GRect draw_rect = GRect(0, y, bounds.size.w, size.h + PADDING);
        if (draw) {
          graphics_context_set_text_color(ctx, GColorBlack);
          graphics_draw_text(ctx, line, header_font, draw_rect, GTextOverflowModeWordWrap, GTextAlignmentLeft, NULL);
        }
        y += size.h + PADDING;
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

        GSize prefix_size = graphics_text_layout_get_content_size(prefix, label_font, GRect(0, 0, bounds.size.w, TEXT_MEASURE_HEIGHT),
                                                                  GTextOverflowModeWordWrap, GTextAlignmentLeft);
        GSize body_size = {0, 0};
        if (remainder[0] != '\0') {
          body_size = graphics_text_layout_get_content_size(remainder, body_font, GRect(0, 0, bounds.size.w, TEXT_MEASURE_HEIGHT),
                                                            GTextOverflowModeWordWrap, GTextAlignmentLeft);
        }
        if (draw) {
          graphics_context_set_text_color(ctx, GColorBlack);
          graphics_draw_text(ctx, prefix, label_font, GRect(0, y, bounds.size.w, prefix_size.h + PADDING),
                             GTextOverflowModeWordWrap, GTextAlignmentLeft, NULL);
          if (remainder[0] != '\0') {
            graphics_draw_text(ctx, remainder, body_font, GRect(0, y + prefix_size.h, bounds.size.w, body_size.h + PADDING),
                               GTextOverflowModeWordWrap, GTextAlignmentLeft, NULL);
          }
        }
        y += prefix_size.h;
        if (remainder[0] != '\0') {
          y += body_size.h;
        }
        y += PADDING;
      } else {
        GRect measure_rect = GRect(0, 0, bounds.size.w, TEXT_MEASURE_HEIGHT);
        GSize size = graphics_text_layout_get_content_size(line, body_font, measure_rect,
                                                           GTextOverflowModeWordWrap, GTextAlignmentLeft);
        GRect draw_rect = GRect(0, y, bounds.size.w, size.h + PADDING);
        if (draw) {
          graphics_context_set_text_color(ctx, GColorBlack);
          graphics_draw_text(ctx, line, body_font, draw_rect, GTextOverflowModeWordWrap, GTextAlignmentLeft, NULL);
        }
        y += size.h + PADDING;
      }
    } else {
      y += PADDING;
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

static void update_settings_text(void) {
  static char settings_text[160];
  snprintf(settings_text, sizeof(settings_text),
           "%c Location: %s\n%c Memory: %s\n%c Calculator: %s\n%c Search: %s",
           s_settings_selection == 0 ? '>' : ' ', s_location_enabled ? "on" : "off",
           s_settings_selection == 1 ? '>' : ' ', s_memory_enabled ? "on" : "off",
           s_settings_selection == 2 ? '>' : ' ', s_calculator_enabled ? "on" : "off",
           s_settings_selection == 3 ? '>' : ' ', s_search_enabled ? "on" : "off");
  text_layer_set_text(s_settings_layer, settings_text);
}

static void open_settings_screen(void) {
  s_settings_return_home = s_show_home;
  s_show_settings = true;
  s_show_sessions = false;
  s_show_home = false;
  update_settings_text();
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

//AI: Draw the idle home screen with usage/model/tool stats from the phone.
static void home_layer_update_proc(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);
  const char *stats = s_stats_text[0] ? s_stats_text : "...";

  graphics_context_set_text_color(ctx, GColorBlack);
  graphics_draw_text(ctx, stats, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
                     GRect(PADDING, PADDING, bounds.size.w - (PADDING * 2), bounds.size.h - PADDING),
                     GTextOverflowModeWordWrap, GTextAlignmentLeft, NULL);
}

//AI: Return true for transcript speaker-name lines that should be drawn in bold.
static bool is_history_label(const char *line) {
  return strcmp(line, "You") == 0 || strcmp(line, "AI") == 0 || strcmp(line, "Error") == 0;
}

//AI: Measure or draw the transcript line by line so labels can be bold and bodies can wrap.
static int16_t layout_history_text(GContext *ctx, GRect bounds, bool draw) {
  GFont label_font = fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD);
  GFont body_font = fonts_get_system_font(FONT_KEY_GOTHIC_24);
  int16_t y = 0;
  char *line = s_chat_history;

  while (line && *line) {
    char *next = strchr(line, '\n');
    if (next) {
      *next = '\0';
    }

    if (line[0] != '\0') {
      bool is_label = is_history_label(line);
      GFont font = is_label ? label_font : body_font;
      GRect measure_rect = GRect(0, 0, bounds.size.w, TEXT_MEASURE_HEIGHT);
      GSize size = graphics_text_layout_get_content_size(line, font, measure_rect,
                                                         GTextOverflowModeWordWrap, GTextAlignmentLeft);
      GRect draw_rect = GRect(0, y, bounds.size.w, size.h + PADDING);
      if (draw) {
        graphics_context_set_text_color(ctx, GColorBlack);
        graphics_draw_text(ctx, line, font, draw_rect, GTextOverflowModeWordWrap, GTextAlignmentLeft, NULL);
      }
      y += size.h + (is_label ? 0 : PADDING);
    } else {
      y += PADDING;
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
  layer_set_hidden(text_layer_get_layer(s_empty_layer), true);
  layer_set_hidden(s_history_layer, s_show_settings || s_show_sessions || s_show_home || !has_history);
  layer_set_hidden(text_layer_get_layer(s_settings_layer), !s_show_settings);
  layer_set_hidden(s_sessions_layer, !s_show_sessions);
  layer_set_hidden(text_layer_get_layer(s_prompt_label_layer), true);
  layer_set_hidden(text_layer_get_layer(s_prompt_layer), true);
  layer_set_hidden(text_layer_get_layer(s_assistant_label_layer), true);
  layer_set_hidden(text_layer_get_layer(s_assistant_layer), true);
  layer_set_hidden(text_layer_get_layer(s_status_message_layer), !show_status_message);

  if (s_show_settings) {
    update_settings_text();
    y += resize_text_layer(s_settings_layer, y, width);
  }

  if (s_show_sessions) {
    int16_t text_width = width - (PADDING * 2);
    int16_t sessions_height = layout_sessions_text(NULL, GRect(0, 0, text_width, TEXT_MEASURE_HEIGHT), false);
    layer_set_frame(s_sessions_layer, GRect(PADDING, y, text_width, sessions_height));
    layer_mark_dirty(s_sessions_layer);
    y += sessions_height;
  }

  if (!s_show_settings && !s_show_sessions && !s_show_home && has_history) {
    int16_t text_width = width - (PADDING * 2);
    int16_t history_height = layout_history_text(NULL, GRect(0, 0, text_width, TEXT_MEASURE_HEIGHT), false);
    layer_set_frame(s_history_layer, GRect(PADDING, y, text_width, history_height));
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
    GSize stats_size = graphics_text_layout_get_content_size(s_stats_text[0] ? s_stats_text : "...",
                                                             fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
                                                             GRect(0, 0, text_width, TEXT_MEASURE_HEIGHT),
                                                             GTextOverflowModeWordWrap, GTextAlignmentLeft);
    int16_t stats_height = stats_size.h + (PADDING * 2);
    content_height = stats_height > bounds.size.h ? stats_height : bounds.size.h;
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
  update_display("Sending...");

  // Start building an outgoing AppMessage dictionary.
  DictionaryIterator *iter;
  AppMessageResult result = app_message_outbox_begin(&iter);
  if (result != APP_MSG_OK || !iter) {
    update_display("Phone not ready");
    return;
  }

  // Put the prompt into the message under the Prompt key, then send it.
  dict_write_cstring(iter, MESSAGE_KEY_Prompt, s_last_prompt);
  dict_write_end(iter);
  result = app_message_outbox_send();
  if (result != APP_MSG_OK) {
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
                              strcmp(status, "Search on") == 0 || strcmp(status, "Search off") == 0)) {
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
    if (s_show_settings) {
      update_settings_text();
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

  //USR: Update text/display with new info
  //AI: Rebuild and redraw the watch text view using the latest status and response.
  update_display(status);
}

// Pebble dictation calls this after speech recognition succeeds or fails.
//USR: If user has finished their dictation, then send it to the Phone, else update the display with a "Dictation cancelled"
//AI: If speech recognition succeeded, send the transcription to the phone; otherwise show "Dictation cancelled".
static void dictation_callback(DictationSession *session, DictationSessionStatus status,
                               char *transcription, void *context) {
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
  if (s_show_settings) {
    toggle_selected_setting();
    return;
  }

  // Ask Pebble to show its dictation UI and start listening to the microphone.
  dictation_session_start(s_dictation_session);
}

static void select_long_click_handler(ClickRecognizerRef recognizer, void *context) {
  clear_watch_session();

  send_simple_command(MESSAGE_KEY_ClearSession, "Cleared watch only");
}

static void back_click_handler(ClickRecognizerRef recognizer, void *context) {
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
  open_settings_screen();
}

static void down_long_click_handler(ClickRecognizerRef recognizer, void *context) {
  open_sessions_screen();
}

static void up_click_handler(ClickRecognizerRef recognizer, void *context) {
  if (s_show_settings) {
    s_settings_selection = (s_settings_selection + 3) % 4;
    update_display("Ready");
  } else if (s_show_home) {
    open_settings_screen();
  } else {
    scroll_layer_set_content_offset(s_scroll_layer,
                                    GPoint(0, scroll_layer_get_content_offset(s_scroll_layer).y + 40), false);
  }
}

static void down_click_handler(ClickRecognizerRef recognizer, void *context) {
  if (s_show_settings) {
    s_settings_selection = (s_settings_selection + 1) % 4;
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
  s_empty_layer = text_layer_create(GRect(PADDING, PADDING, bounds.size.w - (PADDING * 2), 80));
  configure_message_layer(s_empty_layer);
  text_layer_set_text(s_empty_layer, "SELECT: speak\nUP/DOWN: scroll");
  scroll_layer_add_child(s_scroll_layer, text_layer_get_layer(s_empty_layer));

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

  s_settings_layer = text_layer_create(GRectZero);
  configure_message_layer(s_settings_layer);
  scroll_layer_add_child(s_scroll_layer, text_layer_get_layer(s_settings_layer));

  s_sessions_layer = layer_create(GRectZero);
  layer_set_update_proc(s_sessions_layer, sessions_layer_update_proc);
  scroll_layer_add_child(s_scroll_layer, s_sessions_layer);

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
  text_layer_destroy(s_empty_layer);
  text_layer_destroy(s_prompt_label_layer);
  text_layer_destroy(s_prompt_layer);
  text_layer_destroy(s_assistant_label_layer);
  text_layer_destroy(s_assistant_layer);
  layer_destroy(s_history_layer);
  layer_destroy(s_home_layer);
  text_layer_destroy(s_status_message_layer);
  text_layer_destroy(s_settings_layer);
  layer_destroy(s_sessions_layer);
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
  //AI: Open AppMessage and reserve 2048 bytes for incoming messages and 1024 for outgoing ones.

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
