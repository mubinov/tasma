import { describe, expect, it } from "vitest";
import { taskIdOf, taskLinkSegment } from "../../src/http/task-link.js";

describe("the id a task link names", () => {
  it.each([
    ["AB-12", "AB-12"],
    ["ab-12", "AB-12"],
    ["Ab7-0", "AB7-0"],
    ["ABCDEFGH-1", "ABCDEFGH-1"],
  ])("reads %s as %s", (segment, id) => {
    expect(taskIdOf(segment)).toBe(id);
  });

  it.each([
    ["no dash", "foo"],
    ["a tag that starts with a digit", "1A-2"],
    ["no number", "AB-"],
    ["a number that is not digits", "AB-x"],
    ["a second dash in the number", "AB-1-2"],
    ["a tag of one character", "A-1"],
    ["a tag of nine characters", "ABCDEFGHI-1"],
    ["no tag", "-1"],
    ["an encoded dash", "AB%2D1"],
    ["an encoded slash", "AB-1%2F2"],
    ["an encoded non-ASCII letter", "A%C3%9F-1"],
    ["a letter that uppercases to ASCII letters", "Aß-1"],
    ["a digit that is not ASCII", "AB-١"],
  ])("refuses %s", (_description, segment) => {
    expect(taskIdOf(segment)).toBeUndefined();
  });
});

describe("the requests the task link page takes", () => {
  it.each([
    ["/task/AB-12", "AB-12"],
    ["/task/AB-12/", "AB-12"],
    ["/task/AB-12?x=1", "AB-12"],
    ["/task/AB-12/?x=1", "AB-12"],
    ["/task/foo", "foo"],
  ])("takes GET %s with the segment %s", (target, segment) => {
    expect(taskLinkSegment("GET", target)).toBe(segment);
  });

  it.each([
    ["POST", "/task/AB-12"],
    ["HEAD", "/task/AB-12"],
    ["GET", "/task"],
    ["GET", "/task/"],
    ["GET", "/task/AB-12//"],
    ["GET", "/task/AB-12/x"],
    ["GET", "/tasks/AB-12"],
    ["GET", "/x/task/AB-12"],
  ])("leaves %s %s to the router", (method, target) => {
    expect(taskLinkSegment(method, target)).toBeUndefined();
  });
});
