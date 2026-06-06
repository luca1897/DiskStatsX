CC := clang
CFLAGS := -O3 -std=c11 -Wall -Wextra -Wpedantic
LDLIBS := -lsqlite3
TARGET := scanner

.PHONY: all clean

all: $(TARGET)

$(TARGET): scanner.c scanner.h
	$(CC) $(CFLAGS) -o $(TARGET) scanner.c $(LDLIBS)

clean:
	rm -f $(TARGET)
