# Native build of the Sonubrace DSP self-test.
#   make        -> sonubrace_demo
#   make test   -> build and run
#   make clean

CC      ?= gcc
CFLAGS  ?= -std=c99 -O2 -Wall -Wextra -Wno-unused-parameter
LDFLAGS ?= -lm

TARGET  := sonubrace_demo
SRC     := sonubrace_dsp.c main.c

$(TARGET): $(SRC) sonubrace_dsp.h
	$(CC) $(CFLAGS) -o $@ $(SRC) $(LDFLAGS)

.PHONY: test clean
test: $(TARGET)
	./$(TARGET)

clean:
	rm -f $(TARGET) $(TARGET).exe sonubrace_dsp.js sonubrace_dsp.wasm
