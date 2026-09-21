import { deepStrictEqual, doesNotThrow, ok, strictEqual, throws } from "assert";
import { Parser } from "../lib/binary_parser";

interface BoundedError extends Error {
  fieldPath: string;
  offset: number;
  rangeStart: number;
  rangeEnd: number;
  consumed?: number;
}

function boundedParserTests(
  name: string,
  factory: (array: Uint8Array | number[]) => Uint8Array,
) {
  describe(`Bounded parser (${name})`, () => {
    function buf(bytes: number[]): Uint8Array {
      return factory(bytes);
    }

    function expectBoundedError(
      fn: () => unknown,
      expected: {
        path?: string;
        offset?: number;
        range?: [number, number];
        consumed?: number;
        messageMatch?: RegExp;
      },
    ) {
      try {
        fn();
        throw new Error("Expected parse to throw");
      } catch (error) {
        const bounded = error as BoundedError;
        ok(bounded instanceof Error, "thrown value must be an Error");
        ok(bounded.message.length > 0, "error must carry a message");
        if (expected.path !== undefined) {
          strictEqual(bounded.fieldPath, expected.path);
        }
        if (expected.offset !== undefined) {
          strictEqual(bounded.offset, expected.offset);
        }
        if (expected.range) {
          strictEqual(bounded.rangeStart, expected.range[0]);
          strictEqual(bounded.rangeEnd, expected.range[1]);
        }
        if (expected.consumed !== undefined) {
          strictEqual(bounded.consumed, expected.consumed);
        }
        if (expected.messageMatch) {
          ok(
            expected.messageMatch.test(bounded.message),
            `message "${bounded.message}" must match ${expected.messageMatch}`,
          );
        }
      }
    }

    describe("frame declaration", () => {
      it("parses a constant-length frame and resumes after it", () => {
        const parser = Parser.start()
          .uint8("head")
          .bounded("box", {
            type: Parser.start().uint8("a").uint8("b"),
            bounds: 2,
          })
          .uint8("tail");

        deepStrictEqual(parser.parse(buf([9, 1, 2, 3])), {
          head: 9,
          box: { a: 1, b: 2 },
          tail: 3,
        });
      });

      it("accepts the frame length from a previous field", () => {
        const parser = Parser.start()
          .uint8("len")
          .bounded("box", {
            type: Parser.start().array("items", { type: "uint8", length: 3 }),
            bounds: "len",
          });

        deepStrictEqual(parser.parse(buf([3, 4, 5, 6])), {
          len: 3,
          box: { items: [4, 5, 6] },
        });
      });

      it("accepts the frame length from a restricted callback", () => {
        const parser = Parser.start()
          .uint8("len")
          .bounded("box", {
            type: Parser.start().array("items", { type: "uint8", length: 2 }),
            bounds: (item: { len: number }) => item.len + 1,
          });

        deepStrictEqual(parser.parse(buf([1, 7, 8, 9])), {
          len: 1,
          box: { items: [7, 8] },
        });
      });

      it("supports anonymous frames that embed fields in the parent", () => {
        const parser = Parser.start()
          .uint8("len")
          .bounded({
            type: Parser.start().uint8("a").uint8("b"),
            bounds: "len",
          })
          .uint8("tail");

        deepStrictEqual(parser.parse(buf([2, 1, 2, 3])), {
          len: 2,
          a: 1,
          b: 2,
          tail: 3,
        });
      });

      it("supports the options-object form of bounds", () => {
        const parser = Parser.start().bounded("box", {
          type: Parser.start().uint8("a"),
          bounds: { length: 2, consume: "allow-trailing" },
        });

        deepStrictEqual(parser.parse(buf([1, 2])), {
          box: { a: 1 },
        });
      });
    });

    describe("consume strategies", () => {
      it("defaults to exact consumption and fails on trailing bytes", () => {
        const parser = Parser.start().bounded("box", {
          type: Parser.start().uint8("a"),
          bounds: 3,
        });

        expectBoundedError(() => parser.parse(buf([1, 2, 3])), {
          path: ".box",
          offset: 1,
          range: [0, 3],
          consumed: 1,
          messageMatch: /consumed only 1 of 3/,
        });
      });

      it("fails on zero consumption for a non-empty exact frame", () => {
        const parser = Parser.start().bounded("box", {
          type: Parser.start(),
          bounds: 2,
        });

        expectBoundedError(() => parser.parse(buf([1, 2])), {
          range: [0, 2],
          consumed: 0,
          messageMatch: /consumed 0|consumed no bytes|no bytes/,
        });
      });

      it("allows an empty sub-parser inside a zero-length exact frame", () => {
        const parser = Parser.start().bounded("box", {
          type: Parser.start(),
          bounds: 0,
        });

        deepStrictEqual(parser.parse(buf([])), { box: {} });
      });

      it("skips trailing bytes with allow-trailing", () => {
        const parser = Parser.start()
          .bounded("box", {
            type: Parser.start().uint8("a"),
            bounds: { length: 3, consume: "allow-trailing" },
          })
          .uint8("tail");

        deepStrictEqual(parser.parse(buf([1, 2, 3, 9])), {
          box: { a: 1 },
          tail: 9,
        });
      });

      it("keeps trailing bytes in a named field with keep-trailing", () => {
        const parser = Parser.start()
          .bounded("box", {
            type: Parser.start().uint8("a"),
            bounds: {
              length: 3,
              consume: "keep-trailing",
              trailing: "rest",
            },
          })
          .uint8("tail");

        const result = parser.parse(buf([1, 2, 3, 9])) as any;
        strictEqual(result.box.a, 1);
        strictEqual(result.tail, 9);
        deepStrictEqual(Array.from(result.box.rest), [2, 3]);
      });

      it("stores an empty trailing buffer when nothing remains", () => {
        const parser = Parser.start().bounded("box", {
          type: Parser.start().uint8("a").uint8("b"),
          bounds: { length: 2, consume: "keep-trailing", trailing: "rest" },
        });

        const result = parser.parse(buf([1, 2])) as any;
        deepStrictEqual(Array.from(result.box.rest), []);
      });

      it("rejects over-consumption for allow-trailing and keep-trailing", () => {
        for (const consume of ["allow-trailing", "keep-trailing"] as const) {
          const parser = Parser.start().bounded("box", {
            type: Parser.start().uint8("a").uint8("b"),
            bounds: {
              length: 1,
              consume,
              ...(consume === "keep-trailing" ? { trailing: "rest" } : {}),
            },
          });

          // The second byte read itself trips the range check before the
          // frame exit policy runs.
          expectBoundedError(() => parser.parse(buf([1, 2])), {
            path: ".box.b",
            range: [0, 1],
            messageMatch: /out of bounds/,
          });
        }
      });
    });

    describe("pointer constraints", () => {
      it("constrains absolute pointers to the active frame", () => {
        const parser = Parser.start()
          .uint8("len")
          .bounded("box", {
            type: Parser.start()
              .uint8("first")
              .uint8("second")
              .pointer("p", { type: "uint8", offset: 1 }),
            bounds: { length: "len", consume: "allow-trailing" },
          });

        // Frame is [1, 4); frame-relative offset 1 => global offset 2.
        deepStrictEqual(parser.parse(buf([3, 10, 20, 30])), {
          len: 3,
          box: { first: 10, second: 20, p: 20 },
        });
      });

      it("rejects an absolute pointer leaving the frame", () => {
        const parser = Parser.start()
          .uint8("len")
          .bounded("box", {
            type: Parser.start()
              .uint8("first")
              .pointer("p", { type: "uint8", offset: 3 }),
            bounds: { length: "len", consume: "allow-trailing" },
          });

        expectBoundedError(() => parser.parse(buf([3, 10, 20, 30])), {
          path: ".box.p",
          offset: 4,
          range: [1, 4],
          messageMatch: /outside the bounded frame/,
        });
      });

      it("constrains relative pointers to the active frame", () => {
        const parser = Parser.start()
          .uint8("len")
          .bounded("box", {
            type: Parser.start().uint8("first").uint8("second").pointer("p", {
              type: "uint8",
              offset: 1,
              relative: true,
            }),
            bounds: { length: "len", consume: "allow-trailing" },
          });

        // Frame [1, 5); at global offset 3, +1 => global offset 4.
        deepStrictEqual(parser.parse(buf([4, 10, 20, 30, 40])), {
          len: 4,
          box: { first: 10, second: 20, p: 40 },
        });
      });

      it("rejects a relative pointer leaving the frame", () => {
        const parser = Parser.start()
          .uint8("len")
          .bounded("box", {
            type: Parser.start().uint8("first").pointer("p", {
              type: "uint8",
              offset: 4,
              relative: true,
            }),
            bounds: { length: "len", consume: "allow-trailing" },
          });

        expectBoundedError(() => parser.parse(buf([3, 10, 20, 30])), {
          path: ".box.p",
          range: [1, 4],
          messageMatch: /outside the bounded frame/,
        });
      });

      it("restores the parent bounds after a nested frame exits", () => {
        const parser = Parser.start()
          .uint8("l1")
          .bounded("outer", {
            type: Parser.start()
              .uint8("l2")
              .bounded("inner", {
                type: Parser.start().uint8("x"),
                bounds: "l2",
              })
              .uint8("y")
              .pointer("p", { type: "uint8", offset: 2 }),
            bounds: { length: "l1", consume: "allow-trailing" },
          })
          .uint8("end");

        // outer [1, 5); at global offset 3, frame-relative pointer offset
        // 2 => global 3 (absolute pointers are frame-base relative).
        deepStrictEqual(parser.parse(buf([4, 1, 77, 55, 99, 6])), {
          l1: 4,
          outer: { l2: 1, inner: { x: 77 }, y: 55, p: 55 },
          end: 6,
        });
      });

      it("prevents an inner frame pointer from escaping into the parent", () => {
        const parser = Parser.start()
          .uint8("l1")
          .bounded("outer", {
            type: Parser.start()
              .uint8("l2")
              .bounded("inner", {
                type: Parser.start()
                  .uint8("x")
                  .pointer("p", { type: "uint8", offset: 2 }),
                bounds: { length: "l2", consume: "allow-trailing" },
              }),
            bounds: { length: "l1", consume: "allow-trailing" },
          });

        // inner frame [2, 3); frame-relative offset 2 => global 4, which is
        // inside the parent frame but outside the inner frame.
        expectBoundedError(() => parser.parse(buf([3, 1, 77, 55, 99])), {
          path: ".outer.inner.p",
          offset: 4,
          range: [2, 3],
          messageMatch: /outside the bounded frame/,
        });
      });
    });

    describe("invalid frame lengths", () => {
      const emptyInner = Parser.start();

      const invalidLengths: Array<[number | string, string]> = [
        [-1, "-1"],
        [1.5, "1.5"],
        [NaN, "NaN"],
        [Infinity, "Infinity"],
        [-Infinity, "-Infinity"],
        [Number.MAX_SAFE_INTEGER + 1, "2^53"],
      ];

      for (const [length, label] of invalidLengths) {
        it(`rejects ${label} as a constant length`, () => {
          const parser = Parser.start().bounded("box", {
            type: emptyInner,
            bounds: length as number,
          });

          expectBoundedError(() => parser.parse(buf([])), {
            path: ".box",
            messageMatch: /invalid bounded length/,
          });
        });
      }

      it("rejects a callback returning a float length", () => {
        const parser = Parser.start().bounded("box", {
          type: emptyInner,
          bounds: () => 2.5,
        });

        expectBoundedError(() => parser.parse(buf([1, 2, 3])), {
          messageMatch: /invalid bounded length 2.5/,
        });
      });

      it("rejects a field value that is negative", () => {
        const parser = Parser.start()
          .int8("len")
          .bounded("box", { type: emptyInner, bounds: "len" });

        expectBoundedError(() => parser.parse(buf([-4])), {
          messageMatch: /invalid bounded length -4/,
        });
      });
    });

    describe("truncated buffers and read bounds", () => {
      it("rejects a frame extending past the end of the buffer", () => {
        const parser = Parser.start()
          .uint8("len")
          .bounded("box", {
            type: Parser.start().uint8("a"),
            bounds: "len",
          });

        expectBoundedError(() => parser.parse(buf([4, 1])), {
          path: ".box",
          offset: 1,
          range: [0, 2],
          consumed: 1,
          messageMatch: /out of bounds/,
        });
      });

      it("rejects an inner read crossing the frame boundary", () => {
        const parser = Parser.start().bounded("box", {
          type: Parser.start().uint16be("v"),
          bounds: 1,
        });

        expectBoundedError(() => parser.parse(buf([1, 2])), {
          path: ".box.v",
          offset: 0,
          range: [0, 1],
          consumed: 0,
          messageMatch: /read of 2 byte\(s\) out of bounds/,
        });
      });

      it("limits eof reads to the frame end", () => {
        const parser = Parser.start()
          .uint8("x")
          .bounded("box", {
            type: Parser.start().buffer("rest", { readUntil: "eof" }),
            bounds: 2,
          })
          .uint8("tail");

        const result = parser.parse(buf([0, 9, 9, 8])) as any;
        deepStrictEqual(Array.from(result.box.rest), [9, 9]);
        strictEqual(result.tail, 8);
      });

      it("limits greedy and zero terminated strings to the frame end", () => {
        const parser = Parser.start().bounded("box", {
          type: Parser.start().string("s", { zeroTerminated: true }),
          bounds: 3,
        });

        expectBoundedError(() => parser.parse(buf([65, 66, 67])), {
          path: ".box.s",
          range: [0, 3],
          messageMatch: /unterminated string/,
        });
      });

      it("constrains seek to the frame", () => {
        const parser = Parser.start().bounded("box", {
          type: Parser.start().seek(3),
          bounds: 2,
        });

        expectBoundedError(() => parser.parse(buf([1, 2, 3])), {
          messageMatch: /out of bounds/,
        });
      });
    });

    describe("error context", () => {
      it("annotates assertion failures with path, range and consumed", () => {
        const parser = Parser.start().bounded("box", {
          type: Parser.start().uint8("a", { assert: 9 }),
          bounds: 2,
        });

        expectBoundedError(() => parser.parse(buf([5, 0])), {
          path: ".box.a",
          offset: 1,
          range: [0, 2],
          consumed: 1,
          messageMatch: /Assertion error/,
        });
      });

      it("annotates errors thrown by formatters", () => {
        const parser = Parser.start().bounded("box", {
          type: Parser.start().uint8("a", {
            formatter: () => {
              throw new Error("boom");
            },
          }),
          bounds: 2,
        });

        expectBoundedError(() => parser.parse(buf([5, 0])), {
          path: ".box.a",
          range: [0, 2],
          consumed: 1,
          messageMatch: /boom/,
        });
      });

      it("builds array indices into the field path", () => {
        const parser = Parser.start()
          .uint8("len")
          .bounded("box", {
            type: Parser.start().array("items", {
              type: Parser.start().uint8("a", { assert: 1 }),
              length: 3,
            }),
            bounds: "len",
          });

        expectBoundedError(() => parser.parse(buf([3, 1, 5, 1])), {
          path: ".box.items[1].a",
          offset: 3,
          range: [1, 4],
          consumed: 2,
        });
      });
    });

    describe("state isolation and determinism", () => {
      it("produces identical results on repeated parses", () => {
        const parser = Parser.start()
          .uint8("len")
          .bounded("box", {
            type: Parser.start().uint8("a"),
            bounds: "len",
          });
        const input = buf([1, 7]);
        deepStrictEqual(parser.parse(input), parser.parse(input));
      });

      it("keeps parsing after a previous failure (no stack pollution)", () => {
        const parser = Parser.start()
          .uint8("len")
          .bounded("box", {
            type: Parser.start().uint8("a"),
            bounds: "len",
          });

        throws(() => parser.parse(buf([2, 7])));
        // A second, valid parse must not see leftover frame/path state.
        deepStrictEqual(parser.parse(buf([1, 7])), {
          len: 1,
          box: { a: 7 },
        });
      });

      it("restores bounds after an error inside a nested frame", () => {
        const parser = Parser.start()
          .uint8("l1")
          .bounded("outer", {
            type: Parser.start()
              .uint8("l2")
              .bounded("inner", {
                type: Parser.start().uint8("a", { assert: 1 }),
                bounds: "l2",
              }),
            bounds: { length: "l1", consume: "allow-trailing" },
          })
          .uint8("tail");

        throws(() => parser.parse(buf([2, 1, 9, 9])));
        throws(() => parser.parse(buf([2, 1, 8, 8])));
        deepStrictEqual(parser.parse(buf([2, 1, 1, 7])), {
          l1: 2,
          outer: { l2: 1, inner: { a: 1 } },
          tail: 7,
        });
      });
    });

    describe("aliased sub-parsers", () => {
      it("shares the frame stack with named parsers", () => {
        const child = Parser.start().namely("boundedChild").uint8("w");
        const node = Parser.start()
          .namely("boundedNode")
          .uint8("v")
          .bounded("inner", {
            type: "boundedChild",
            bounds: 1,
            consume: "allow-trailing",
          });
        void child;
        void node;

        const parser = Parser.start()
          .uint8("len")
          .bounded("box", {
            type: "boundedNode",
            bounds: { length: "len", consume: "allow-trailing" },
          });

        deepStrictEqual(parser.parse(buf([2, 10, 20, 99])), {
          len: 2,
          box: { v: 10, inner: { w: 20 } },
        });
      });

      it("rejects out-of-frame reads performed by named parsers", () => {
        const child = Parser.start().namely("boundedChild2").uint16be("w");
        void child;

        const parser = Parser.start().bounded("box", {
          type: "boundedChild2",
          bounds: 1,
        });

        expectBoundedError(() => parser.parse(buf([1, 2])), {
          path: ".box.w",
          range: [0, 1],
          messageMatch: /out of bounds/,
        });
      });
    });

    describe("validation and compatibility", () => {
      it("rejects a bounded frame without bounds or type", () => {
        throws(
          () =>
            Parser.start().bounded("box", {
              type: Parser.start().uint8("a"),
            } as any),
          /bounds is required/,
        );
        throws(
          () => Parser.start().bounded("box", { bounds: 1 } as any),
          /type is required/,
        );
      });

      it("rejects an unknown consume strategy and missing trailing field", () => {
        throws(
          () =>
            Parser.start().bounded("box", {
              type: Parser.start(),
              bounds: { length: 1, consume: "weird" as any },
            }),
          /consume must be one of/,
        );
        throws(
          () =>
            Parser.start().bounded("box", {
              type: Parser.start(),
              bounds: { length: 1, consume: "keep-trailing" },
            }),
          /trailing field name is required/,
        );
      });

      it("does not change the generated code of parsers without bounded", () => {
        const parser = Parser.start()
          .uint8("a")
          .uint16be("b")
          .nest("c", {
            type: Parser.start()
              .uint8("x")
              .array("y", { type: "uint8", length: 2 }),
          })
          .pointer("p", { type: "uint8", offset: 0 });

        const code = parser.getCode();
        ok(!code.includes("$frames"), "must not emit a bounds frame stack");
        ok(!code.includes("$checkRange"), "must not emit range checks");
        ok(!code.includes("$path"), "must not emit a runtime path stack");
        doesNotThrow(() => parser.parse(buf([1, 0, 2, 3, 4, 5, 6])));
      });

      it("supports bounded on an aliased top-level parser", () => {
        const parser = Parser.start()
          .namely("boundedRoot")
          .uint8("a")
          .bounded("inner", {
            type: Parser.start().uint8("b"),
            bounds: 1,
          });

        deepStrictEqual(parser.parse(buf([1, 2])), {
          a: 1,
          inner: { b: 2 },
        });
      });

      it("reports the declared frame size via sizeOf", () => {
        const parser = Parser.start()
          .uint8("head")
          .bounded("box", {
            type: Parser.start().uint8("a"),
            bounds: 4,
          })
          .uint8("tail");

        strictEqual(parser.sizeOf(), 6);
      });
    });

    describe("composite types inside frames", () => {
      it("bounds-checks bit fields against the frame", () => {
        const parser = Parser.start().bounded("box", {
          type: new Parser().bit4("high").bit4("low"),
          bounds: 1,
        });

        deepStrictEqual(parser.parse(buf([0xab])), {
          box: { high: 0xa, low: 0xb },
        });

        expectBoundedError(
          () =>
            Parser.start()
              .bounded("box", {
                type: new Parser().bit4("high").bit4("low"),
                bounds: 0,
              })
              .parse(buf([1])),
          { range: [0, 0], messageMatch: /out of bounds/ },
        );
      });

      it("bounds-checks the parser chosen by a choice", () => {
        const parser = Parser.start().bounded("box", {
          type: Parser.start()
            .uint8("tag")
            .choice("value", {
              tag: "tag",
              choices: {
                1: Parser.start().uint16be("v"),
              },
            }),
          bounds: 2,
        });

        expectBoundedError(() => parser.parse(buf([1, 0x12, 0x34, 0x56])), {
          path: ".box.value.v",
          range: [0, 2],
          messageMatch: /out of bounds/,
        });
      });

      it("rejects a seek that moves outside the frame", () => {
        const parser = Parser.start().bounded("box", {
          type: Parser.start().seek(-2),
          bounds: 1,
        });

        expectBoundedError(() => parser.parse(buf([1])), {
          range: [0, 1],
          messageMatch: /out of bounds/,
        });
      });

      it("parses wrapped buffers inside a frame and restores the frame", () => {
        const parser = Parser.start()
          .uint8("outer")
          .bounded("box", {
            type: Parser.start().wrapped("w", {
              length: 2,
              wrapper: (buffer) => buffer,
              type: Parser.start().uint8("a"),
            }),
            bounds: 2,
          })
          .uint8("tail");

        deepStrictEqual(parser.parse(buf([0, 7, 8, 9])), {
          outer: 0,
          box: { w: { a: 7 } },
          tail: 9,
        });
      });

      it("limits readUntil buffers to the frame", () => {
        const parser = Parser.start().bounded("box", {
          type: Parser.start().buffer("data", {
            length: 3,
          }),
          bounds: 2,
        });

        expectBoundedError(() => parser.parse(buf([1, 2, 3])), {
          path: ".box.data",
          range: [0, 2],
        });
      });

      it("rejects a negative dynamic array length", () => {
        const parser = Parser.start().bounded("box", {
          type: Parser.start()
            .int8("len")
            .array("items", { type: "uint8", length: "len" }),
          bounds: 2,
        });

        expectBoundedError(() => parser.parse(buf([-1, 1])), {
          path: ".box.items",
          messageMatch: /invalid array length -1/,
        });
      });
    });
  });
}

boundedParserTests("Buffer", (arr) => Buffer.from(arr));
boundedParserTests("Uint8Array", (arr) => Uint8Array.from(arr));
