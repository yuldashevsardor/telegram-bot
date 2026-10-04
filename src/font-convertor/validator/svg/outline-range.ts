import type { PathSegment } from "app/font-convertor/validator/svg/path-data";

// The converted font keeps a point as a signed 16-bit shift from the point before it (`glyf`, the
// charstring of a CFF) and the box of a glyph in signed 16-bit fields (the `glyf` header, `hmtx`).
// The lowest value, -32768, is left out, as in the other ranges of the validator.
const MAX_FONT_UNITS = 32767;

type Point = {
    x: number;
    y: number;
};

const ORIGIN: Point = { x: 0, y: 0 };

/**
 * The control point the last command leaves for a smooth command after it: the second control point
 * of a cubic curve for `S`, the control point of a quadratic one for `T`. Any other command leaves
 * none.
 */
type Control = {
    isQuadratic: boolean;
    point: Point;
};

/**
 * Follows the current point through the commands of §8.3 and the points the converted font stores
 * on the way: a point past the range is written as another one without a word (measured on
 * fontforge 20230101, docs/architecture/font-convertor.md). The check is not exact where fontforge
 * builds points itself, and errs towards rejecting:
 *
 * - The control points of a curve bound it, so a control point past the range counts, though
 *   fontforge would store the curve.
 * - A TrueType outline drops the on-curve point between two off-curve ones when it is their
 *   midpoint, so the shift between the control points of two quadratic curves in a row counts.
 * - A CFF contour is closed by a line, and the next moveto is a shift from its start, so both
 *   count, though a TrueType one stores neither.
 * - An arc is checked by its end point and its radii, not by the points fontforge builds on it.
 */
class OutlineWalker {
    private currentPoint = ORIGIN;
    // The last point of the outline in the font: not the current point, which a closepath moves.
    private lastStoredPoint = ORIGIN;
    private contourStart = ORIGIN;
    private isContourOpen = false;
    private lastControl: Control | undefined;
    private fits = true;

    public constructor(private readonly segments: ReadonlyArray<PathSegment>) {}

    public walk(): boolean {
        for (const segment of this.segments) {
            this.walkSegment(segment);
        }

        this.closeContour();

        return this.fits;
    }

    private walkSegment(segment: PathSegment): void {
        const values = segment.values;
        const origin = segment.command === segment.command.toLowerCase() ? this.currentPoint : ORIGIN;
        const command = segment.command.toUpperCase();

        if (command === "Z") {
            this.closeContour();
            this.currentPoint = this.contourStart;
            this.lastControl = undefined;

            return;
        }

        if (command === "M") {
            this.closeContour();
            this.beginContour(this.pointAt(origin, values, 0));
            this.lastControl = undefined;

            return;
        }

        // Drawing right after a closepath starts a new subpath where the closepath left the point.
        if (!this.isContourOpen) {
            this.beginContour(this.currentPoint);
        }

        switch (command) {
            case "L":
                this.lineTo(this.pointAt(origin, values, 0));
                break;
            case "H":
                this.lineTo({ x: origin.x + this.argument(values, 0), y: this.currentPoint.y });
                break;
            case "V":
                this.lineTo({ x: this.currentPoint.x, y: origin.y + this.argument(values, 0) });
                break;
            case "C":
                this.cubicTo(this.pointAt(origin, values, 0), this.pointAt(origin, values, 2), this.pointAt(origin, values, 4));
                break;
            case "S":
                this.cubicTo(this.reflectedControl(false), this.pointAt(origin, values, 0), this.pointAt(origin, values, 2));
                break;
            case "Q":
                this.quadraticTo(this.pointAt(origin, values, 0), this.pointAt(origin, values, 2));
                break;
            case "T":
                this.quadraticTo(this.reflectedControl(true), this.pointAt(origin, values, 0));
                break;
            default:
                this.arcTo(values, this.pointAt(origin, values, 5));
        }
    }

    private lineTo(endPoint: Point): void {
        this.store(endPoint);
        this.currentPoint = endPoint;
        this.lastControl = undefined;
    }

    private cubicTo(firstControl: Point, secondControl: Point, endPoint: Point): void {
        this.store(firstControl);
        this.store(secondControl);
        this.store(endPoint);
        this.currentPoint = endPoint;
        this.lastControl = { isQuadratic: false, point: secondControl };
    }

    private quadraticTo(control: Point, endPoint: Point): void {
        if (this.lastControl?.isQuadratic === true) {
            this.checkShift(this.lastControl.point, control);
        }

        this.store(control);
        this.store(endPoint);
        this.currentPoint = endPoint;
        this.lastControl = { isQuadratic: true, point: control };
    }

    /**
     * The arguments of an arc are the two radii, the rotation, the two flags and the end point
     * (§8.3.8).
     */
    private arcTo(values: ReadonlyArray<number>, endPoint: Point): void {
        if (this.argument(values, 0) > MAX_FONT_UNITS || this.argument(values, 1) > MAX_FONT_UNITS) {
            this.fits = false;
        }

        this.lineTo(endPoint);
    }

    /**
     * A TrueType contour stores its start as a shift from the last point of the contour before, a
     * CFF one from the start of that contour.
     */
    private beginContour(startPoint: Point): void {
        this.checkShift(this.contourStart, startPoint);
        this.store(startPoint);
        this.contourStart = startPoint;
        this.currentPoint = startPoint;
        this.isContourOpen = true;
    }

    private closeContour(): void {
        if (!this.isContourOpen) {
            return;
        }

        this.checkShift(this.lastStoredPoint, this.contourStart);
        this.isContourOpen = false;
    }

    private store(point: Point): void {
        this.checkShift(this.lastStoredPoint, point);

        if (!this.isWithin(point.x) || !this.isWithin(point.y)) {
            this.fits = false;
        }

        this.lastStoredPoint = point;
    }

    private checkShift(from: Point, to: Point): void {
        if (!this.isWithin(to.x - from.x) || !this.isWithin(to.y - from.y)) {
            this.fits = false;
        }
    }

    private isWithin(value: number): boolean {
        return Math.abs(value) <= MAX_FONT_UNITS;
    }

    // Without a control point of the same kind before it a smooth command takes the current point.
    private reflectedControl(isQuadratic: boolean): Point {
        if (this.lastControl?.isQuadratic !== isQuadratic) {
            return this.currentPoint;
        }

        return {
            x: 2 * this.currentPoint.x - this.lastControl.point.x,
            y: 2 * this.currentPoint.y - this.lastControl.point.y,
        };
    }

    private pointAt(origin: Point, values: ReadonlyArray<number>, index: number): Point {
        return { x: origin.x + this.argument(values, index), y: origin.y + this.argument(values, index + 1) };
    }

    // The reader gives a command every argument it takes.
    private argument(values: ReadonlyArray<number>, index: number): number {
        return values[index] as number;
    }
}

/**
 * Says whether the points of the outline `segments` give fit the converted font: each point, and
 * its shift from the point before it, within 32767.
 */
export function isOutlineWithinRange(segments: ReadonlyArray<PathSegment>): boolean {
    return new OutlineWalker(segments).walk();
}
