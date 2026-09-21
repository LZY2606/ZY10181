import { deepStrictEqual, throws, ok } from "assert";
import { Parser } from "../lib/binary_parser";

interface BoundedError extends Error {
  fieldPath?: string;
  absoluteOffset?: number;
  bounds?: [number, number];
  consumed?: number;
}

function boundedParserTests(
  name: string,
  factory: (array: Uint8Array | number[]) => Uint8Array,
) {
  describe(`Bounded parser (${name})`, () => {
    function hexToBuf(hex: string): Uint8Array {
      return factory(hex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)));
    }

    function catchBoundedError(fn: () => void): BoundedError {
      try {
        fn();
      } catch (error) {
        return error as BoundedError;
      }
      throw new Error("Expected parse to throw, but it did not.");
    }

    describe("Length source", () => {
      it("should parse a sub-parser bounded by a constant length", () => {
        const parser = Parser.start().bounded("payload", {
          length: 2,
          type: Parser.start().uint8("a").uint8("b"),
        });

        deepStrictEqual(parser.parse(hexToBuf("0102")), {
          payload: { a: 1, b: 2 },
        });
      });

      it("should take the length from a previously parsed field", () => {
        const parser = Parser.start()
          .uint8("length")
          .bounded("payload", {
            length: "length",
            type: Parser.start().uint8("a").uint8("b"),
          })
          .uint8("tail");

        deepStrictEqual(parser.parse(hexToBuf("020a14ff")), {
          length: 2,
          payload: { a: 10, b: 20 },
          tail: 0xff,
        });
      });

      it("should take the length from a callback", () => {
        const parser = Parser.start()
          .uint8("count")
          .bounded("payload", {
            length: function (this: { count: number }) {
              return this.count * 2;
            },
            type: Parser.start().uint8("a").uint8("b"),
          });

        deepStrictEqual(parser.parse(hexToBuf("010708")), {
          count: 1,
          payload: { a: 7, b: 8 },
        });
      });

      it("should accept an aliased parser as the sub-parser", () => {
        Parser.start().uint8("value").namely("boundedTestChild");

        const parser = Parser.start().bounded("payload", {
          length: 1,
          type: "boundedTestChild",
        });

        deepStrictEqual(parser.parse(hexToBuf("7f")), {
          payload: { value: 0x7f },
        });
      });
    });

    describe("Trailing strategies", () => {
      it('should require exact consumption with trailing: "error" (default)', () => {
        const parser = Parser.start().bounded("payload", {
          length: 4,
          type: Parser.start().uint8("a"),
        });

        const error = catchBoundedError(() =>
          parser.parse(hexToBuf("01020304")),
        );
        ok(
          error.message.includes(
            "must consume exactly 4 bytes in range [0, 4) but consumed 1",
          ),
          `unexpected message: ${error.message}`,
        );
        deepStrictEqual(error.fieldPath, "payload");
        deepStrictEqual(error.absoluteOffset, 1);
        deepStrictEqual(error.bounds, [0, 4]);
        deepStrictEqual(error.consumed, 1);
      });

      it('should skip trailing bytes with trailing: "skip"', () => {
        const parser = Parser.start()
          .bounded("payload", {
            length: 4,
            type: Parser.start().uint8("a"),
            trailing: "skip",
          })
          .uint8("tail");

        deepStrictEqual(parser.parse(hexToBuf("01020304ff")), {
          payload: { a: 1 },
          tail: 0xff,
        });
      });

      it('should preserve trailing bytes as a field with trailing: "preserve"', () => {
        const parser = Parser.start().bounded("payload", {
          length: 3,
          type: Parser.start().uint8("a"),
          trailing: "preserve",
          trailingVarName: "rest",
        });

        deepStrictEqual(parser.parse(hexToBuf("010203")), {
          payload: { a: 1 },
          rest: factory([2, 3]),
        });
      });

      it("should report consumption past the end of the region", () => {
        const parser = Parser.start().bounded("payload", {
          length: 2,
          type: Parser.start().uint32be("a"),
          trailing: "skip",
        });

        const error = catchBoundedError(() =>
          parser.parse(hexToBuf("01020304")),
        );
        ok(
          error.message.includes("consumed 4 bytes, which exceeds its range"),
          `unexpected message: ${error.message}`,
        );
        deepStrictEqual(error.fieldPath, "payload");
        deepStrictEqual(error.bounds, [0, 2]);
        deepStrictEqual(error.consumed, 4);
      });
    });

    describe("Length validation", () => {
      it("should accept a zero length region", () => {
        const parser = Parser.start()
          .bounded("payload", {
            length: 0,
            type: Parser.start(),
          })
          .uint8("tail");

        deepStrictEqual(parser.parse(hexToBuf("aa")), {
          payload: {},
          tail: 0xaa,
        });
      });

      it("should reject a negative length", () => {
        const parser = Parser.start().bounded("payload", {
          length: -1,
          type: Parser.start(),
        });

        const error = catchBoundedError(() => parser.parse(hexToBuf("0102")));
        ok(
          error.message.includes("Invalid length -1"),
          `unexpected message: ${error.message}`,
        );
        deepStrictEqual(error.fieldPath, "payload");
      });

      it("should reject a non-integer length", () => {
        const parser = Parser.start().bounded("payload", {
          length: 1.5,
          type: Parser.start(),
        });

        const error = catchBoundedError(() => parser.parse(hexToBuf("0102")));
        ok(
          error.message.includes("Invalid length 1.5"),
          `unexpected message: ${error.message}`,
        );
      });

      it("should reject a length beyond the safe integer range", () => {
        const parser = Parser.start().bounded("payload", {
          length: Math.pow(2, 53),
          type: Parser.start(),
        });

        const error = catchBoundedError(() => parser.parse(hexToBuf("0102")));
        ok(
          error.message.includes("Invalid length 9007199254740992"),
          `unexpected message: ${error.message}`,
        );
      });

      it("should reject a region exceeding the enclosing buffer", () => {
        const parser = Parser.start().bounded("payload", {
          length: 100,
          type: Parser.start(),
        });

        const error = catchBoundedError(() => parser.parse(hexToBuf("0102")));
        ok(
          error.message.includes(
            "range [0, 100) exceeds enclosing range [0, 2)",
          ),
          `unexpected message: ${error.message}`,
        );
        deepStrictEqual(error.bounds, [0, 100]);
      });

      it("should reject a region exceeding the enclosing bounded frame", () => {
        const parser = Parser.start().bounded("outer", {
          length: 4,
          type: Parser.start().bounded("inner", {
            length: 8,
            type: Parser.start(),
          }),
          trailing: "skip",
        });

        const error = catchBoundedError(() =>
          parser.parse(hexToBuf("0102030405060708")),
        );
        ok(
          error.message.includes("range [0, 8) exceeds enclosing range [0, 4)"),
          `unexpected message: ${error.message}`,
        );
        deepStrictEqual(error.fieldPath, "outer.inner");
      });
    });

    describe("Boundary enforcement", () => {
      it("should allow an absolute pointer inside the current frame", () => {
        const parser = Parser.start()
          .uint8("header")
          .bounded("payload", {
            length: 4,
            type: Parser.start().pointer("x", {
              type: "uint8",
              offset: 3,
            }),
            trailing: "skip",
          })
          .uint8("tail");

        deepStrictEqual(parser.parse(hexToBuf("ff0102abffee")), {
          header: 0xff,
          payload: { x: 0xab },
          tail: 0xee,
        });
      });

      it("should reject an absolute pointer past the end of the frame", () => {
        const parser = Parser.start().bounded("payload", {
          length: 4,
          type: Parser.start()
            .uint8("target")
            .pointer("x", { type: "uint8", offset: "target" }),
          trailing: "skip",
        });

        const error = catchBoundedError(() =>
          parser.parse(hexToBuf("09010203040506070809")),
        );
        ok(
          error.message.includes(
            "Pointer 'payload.x' points to offset 9, which is outside the current bounded range [0, 4)",
          ),
          `unexpected message: ${error.message}`,
        );
        deepStrictEqual(error.fieldPath, "payload.x");
        deepStrictEqual(error.absoluteOffset, 9);
        deepStrictEqual(error.bounds, [0, 4]);
      });

      it("should reject an absolute pointer before the start of the frame", () => {
        const parser = Parser.start()
          .uint16be("header")
          .bounded("payload", {
            length: 4,
            type: Parser.start().pointer("x", {
              type: "uint8",
              offset: 0,
            }),
            trailing: "skip",
          });

        const error = catchBoundedError(() =>
          parser.parse(hexToBuf("ffff01020304")),
        );
        ok(
          error.message.includes("outside the current bounded range [2, 6)"),
          `unexpected message: ${error.message}`,
        );
        deepStrictEqual(error.bounds, [2, 6]);
      });

      it("should reject a seek escaping the current frame", () => {
        const parser = Parser.start().bounded("payload", {
          length: 2,
          type: Parser.start().seek(10),
          trailing: "skip",
        });

        const error = catchBoundedError(() =>
          parser.parse(hexToBuf("01020304050607080900")),
        );
        ok(
          error.message.includes("seek moved the offset of 'payload' to 10"),
          `unexpected message: ${error.message}`,
        );
      });

      it("should restore the parent frame after a nested frame exits", () => {
        const parser = Parser.start().bounded("outer", {
          length: 6,
          type: Parser.start()
            .bounded("inner", {
              length: 2,
              type: Parser.start().uint8("a").uint8("b"),
            })
            .pointer("escape", { type: "uint8", offset: 100 }),
          trailing: "skip",
        });

        const error = catchBoundedError(() =>
          parser.parse(hexToBuf("010203040506")),
        );
        ok(
          error.message.includes(
            "Pointer 'outer.escape' points to offset 100, which is outside the current bounded range [0, 6)",
          ),
          `unexpected message: ${error.message}`,
        );
        deepStrictEqual(error.bounds, [0, 6]);
      });

      it("should constrain pointers of the root frame to the buffer", () => {
        const parser = Parser.start()
          .bounded("payload", {
            length: 1,
            type: Parser.start().uint8("a"),
          })
          .pointer("far", { type: "uint8", offset: 100 });

        const error = catchBoundedError(() => parser.parse(hexToBuf("01")));
        ok(
          error.message.includes("outside the current bounded range [0, 1)"),
          `unexpected message: ${error.message}`,
        );
      });
    });

    describe("Error recovery", () => {
      it("should propagate assertion failures and keep the parser reusable", () => {
        const parser = Parser.start().bounded("payload", {
          length: 2,
          type: Parser.start().uint8("a", { assert: 42 }).uint8("b"),
        });

        throws(() => parser.parse(hexToBuf("0102")), /Assertion error/);
        deepStrictEqual(parser.parse(hexToBuf("2a01")), {
          payload: { a: 42, b: 1 },
        });
        deepStrictEqual(parser.parse(hexToBuf("2a01")), {
          payload: { a: 42, b: 1 },
        });
      });

      it("should propagate formatter failures and keep the parser reusable", () => {
        const parser = Parser.start().bounded("payload", {
          length: 1,
          type: Parser.start().uint8("a", {
            formatter: () => {
              throw new Error("formatter boom");
            },
          }),
        });

        throws(() => parser.parse(hexToBuf("01")), /formatter boom/);
        throws(() => parser.parse(hexToBuf("01")), /formatter boom/);
      });

      it("should not leak frames after an error inside a nested frame", () => {
        const inner = Parser.start().uint8("a", { assert: 0xcc });
        const parser = Parser.start().bounded("outer", {
          length: 4,
          type: Parser.start()
            .bounded("inner", { length: 1, type: inner })
            .uint8("b"),
          trailing: "skip",
        });

        // The assert fails on the first parse; the frame stack must be
        // restored so that a subsequent parse starts from a clean state.
        throws(() => parser.parse(hexToBuf("01020304")), /Assertion error/);
        throws(() => parser.parse(hexToBuf("01020304")), /Assertion error/);
        deepStrictEqual(parser.parse(hexToBuf("cc02ffff")), {
          outer: { inner: { a: 0xcc }, b: 2 },
        });
      });

      it("should produce identical results when parsing twice with the same instance", () => {
        const parser = Parser.start()
          .uint8("length")
          .bounded("payload", {
            length: "length",
            type: Parser.start().uint8("a"),
            trailing: "preserve",
            trailingVarName: "rest",
          });

        const buffer = hexToBuf("03010203");
        deepStrictEqual(parser.parse(buffer), parser.parse(buffer));
      });
    });

    describe("Compatibility", () => {
      it("should not emit boundary code when bounded is not used", () => {
        const parser = Parser.start()
          .uint8("a")
          .pointer("b", { type: "uint8", offset: 0 })
          .seek(1);

        ok(!parser.getCode().includes("$bounds"));
        deepStrictEqual(parser.parse(hexToBuf("2a2b2c")), { a: 42, b: 42 });
      });

      it("should report the size of a constant length bounded parser", () => {
        const parser = Parser.start()
          .uint8("header")
          .bounded("payload", {
            length: 4,
            type: Parser.start().uint32be("value"),
          });

        deepStrictEqual(parser.sizeOf(), 5);
      });

      it("should validate options at construction time", () => {
        throws(
          () =>
            Parser.start().bounded("payload", { type: Parser.start() } as any),
          /length is required/,
        );
        throws(
          () => Parser.start().bounded("payload", { length: 1 } as any),
          /type is required/,
        );
        throws(
          () =>
            Parser.start().bounded("payload", {
              length: 1,
              type: Parser.start(),
              trailing: "bogus" as any,
            }),
          /trailing must be one of/,
        );
        throws(
          () =>
            Parser.start().bounded("payload", {
              length: 1,
              type: Parser.start(),
              trailing: "preserve",
            }),
          /trailingVarName is required/,
        );
      });
    });
  });
}

boundedParserTests("Buffer", (arr) => Buffer.from(arr));
boundedParserTests("Uint8Array", (arr) => Uint8Array.from(arr));
