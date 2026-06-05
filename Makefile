CC := clang
CFLAGS := -O3 -std=c11 -Wall -Wextra -Wpedantic
TARGET := scanner

.PHONY: all clean

all: $(TARGET)

$(TARGET): scanner.c scanner.h
	$(CC) $(CFLAGS) -o $(TARGET) scanner.c

clean:
	rm -f $(TARGET)
