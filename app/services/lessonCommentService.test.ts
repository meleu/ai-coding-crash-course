import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { MAX_COMMENT_LENGTH } from "~/lib/comments";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

// Import after mock so the module picks up our test db
import {
  createComment,
  deleteComment,
  getCommentAccess,
  getCommentCountsForLessons,
  getLessonComments,
  LessonCommentError,
  updateComment,
} from "./lessonCommentService";

const NO_ACCESS = { canRead: false, canWrite: false, canModerate: false };

let lessonId: number;
let student: typeof schema.users.$inferSelect;
let otherStudent: typeof schema.users.$inferSelect;
let outsider: typeof schema.users.$inferSelect;
let admin: typeof schema.users.$inferSelect;

function createUser(name: string, email: string, role: schema.UserRole) {
  return testDb
    .insert(schema.users)
    .values({ name, email, role })
    .returning()
    .get();
}

function createLesson(moduleId: number, title: string) {
  return testDb
    .insert(schema.lessons)
    .values({ moduleId, title, position: 1 })
    .returning()
    .get();
}

function enroll(userId: number) {
  testDb
    .insert(schema.enrollments)
    .values({ userId, courseId: base.course.id })
    .run();
}

function setCourseStatus(status: schema.CourseStatus) {
  testDb
    .update(schema.courses)
    .set({ status })
    .where(eq(schema.courses.id, base.course.id))
    .run();
}

// A student who bought at a PPP discount in India
function makePppPurchase(userId: number) {
  testDb
    .update(schema.courses)
    .set({ price: 4999, pppEnabled: true })
    .where(eq(schema.courses.id, base.course.id))
    .run();
  testDb
    .insert(schema.purchases)
    .values({ userId, courseId: base.course.id, pricePaid: 999, country: "IN" })
    .run();
}

function findRow(id: number) {
  return testDb
    .select()
    .from(schema.lessonComments)
    .where(eq(schema.lessonComments.id, id))
    .get();
}

function expectCommentError(fn: () => unknown, status: number) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(LessonCommentError);
    expect((error as LessonCommentError).status).toBe(status);
    return;
  }
  throw new Error("Expected a LessonCommentError");
}

describe("lessonCommentService", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);

    student = base.user;
    otherStudent = createUser("Other", "other@example.com", schema.UserRole.Student);
    outsider = createUser("Outsider", "out@example.com", schema.UserRole.Student);
    admin = createUser("Admin", "admin@example.com", schema.UserRole.Admin);
    enroll(student.id);
    enroll(otherStudent.id);

    const mod = testDb
      .insert(schema.modules)
      .values({ courseId: base.course.id, title: "Module", position: 1 })
      .returning()
      .get();
    lessonId = createLesson(mod.id, "Lesson").id;
  });

  describe("getCommentAccess", () => {
    it("gives logged-out visitors nothing", () => {
      expect(getCommentAccess(null, lessonId, null)).toEqual(NO_ACCESS);
    });

    it("gives users who aren't enrolled nothing", () => {
      expect(getCommentAccess(outsider.id, lessonId, null)).toEqual(NO_ACCESS);
    });

    it("gives nothing for a lesson that doesn't exist", () => {
      expect(getCommentAccess(student.id, 9999, null)).toEqual(NO_ACCESS);
    });

    it("lets enrolled students read and write but not moderate", () => {
      expect(getCommentAccess(student.id, lessonId, null)).toEqual({
        canRead: true,
        canWrite: true,
        canModerate: false,
      });
    });

    it("lets the course's instructor moderate without being enrolled", () => {
      expect(getCommentAccess(base.instructor.id, lessonId, null)).toEqual({
        canRead: true,
        canWrite: true,
        canModerate: true,
      });
    });

    it("gives another course's instructor nothing", () => {
      const other = createUser(
        "Other Instructor",
        "oi@example.com",
        schema.UserRole.Instructor
      );

      expect(getCommentAccess(other.id, lessonId, null)).toEqual(NO_ACCESS);
    });

    it("lets admins moderate without being enrolled", () => {
      expect(getCommentAccess(admin.id, lessonId, null)).toEqual({
        canRead: true,
        canWrite: true,
        canModerate: true,
      });
    });

    it.each([schema.CourseStatus.Archived, schema.CourseStatus.Draft])(
      "makes %s courses read-only for everyone",
      (status) => {
        setCourseStatus(status);

        expect(getCommentAccess(student.id, lessonId, null)).toEqual({
          canRead: true,
          canWrite: false,
          canModerate: false,
        });
        expect(getCommentAccess(base.instructor.id, lessonId, null)).toEqual({
          canRead: true,
          canWrite: false,
          canModerate: true,
        });
        expect(getCommentAccess(admin.id, lessonId, null)).toEqual({
          canRead: true,
          canWrite: false,
          canModerate: true,
        });
      }
    );

    describe("PPP purchases", () => {
      beforeEach(() => {
        makePppPurchase(student.id);
      });

      it("allows access from the purchase country", () => {
        expect(getCommentAccess(student.id, lessonId, "IN").canWrite).toBe(true);
      });

      it("allows access when the country can't be detected", () => {
        expect(getCommentAccess(student.id, lessonId, null).canWrite).toBe(true);
      });

      it("blocks access from another country", () => {
        expect(getCommentAccess(student.id, lessonId, "US")).toEqual(NO_ACCESS);
      });

      it("doesn't apply to staff", () => {
        expect(getCommentAccess(admin.id, lessonId, "US").canRead).toBe(true);
      });
    });
  });

  describe("createComment", () => {
    it("stores a trimmed top-level comment", () => {
      const comment = createComment(student.id, lessonId, "  Hello  ", null, null);

      expect(comment.content).toBe("Hello");
      expect(comment.parentId).toBeNull();
      expect(comment.userId).toBe(student.id);
    });

    it("rejects users without access", () => {
      expectCommentError(
        () => createComment(outsider.id, lessonId, "Hi", null, null),
        403
      );
    });

    it("rejects students blocked by the PPP check", () => {
      makePppPurchase(student.id);

      expectCommentError(
        () => createComment(student.id, lessonId, "Hi", null, "US"),
        403
      );
    });

    it("rejects new comments on closed courses, even from staff", () => {
      setCourseStatus(schema.CourseStatus.Archived);

      expectCommentError(
        () => createComment(student.id, lessonId, "Hi", null, null),
        403
      );
      expectCommentError(
        () => createComment(admin.id, lessonId, "Hi", null, null),
        403
      );
    });

    it("rejects empty and whitespace-only comments", () => {
      expectCommentError(
        () => createComment(student.id, lessonId, " \n ", null, null),
        400
      );
    });

    it("enforces the length limit", () => {
      const atLimit = "a".repeat(MAX_COMMENT_LENGTH);

      expect(
        createComment(student.id, lessonId, atLimit, null, null).content
      ).toBe(atLimit);
      expectCommentError(
        () => createComment(student.id, lessonId, `${atLimit}a`, null, null),
        400
      );
    });

    it("counts a line break as one character", () => {
      const half = "a".repeat(MAX_COMMENT_LENGTH / 2 - 1);

      const comment = createComment(
        student.id,
        lessonId,
        `${half}\r\n\r\n${half}`,
        null,
        null
      );

      expect(comment.content).toBe(`${half}\n\n${half}`);
    });

    it("stores markup as plain text", () => {
      const content = "<img src=x onerror=alert(1)>";

      expect(createComment(student.id, lessonId, content, null, null).content).toBe(
        content
      );
    });

    it("adds a reply to a top-level comment", () => {
      const parent = createComment(student.id, lessonId, "Q", null, null);

      const reply = createComment(otherStudent.id, lessonId, "A", parent.id, null);

      expect(reply.parentId).toBe(parent.id);
    });

    it("rejects a reply to a reply", () => {
      const parent = createComment(student.id, lessonId, "Q", null, null);
      const reply = createComment(otherStudent.id, lessonId, "A", parent.id, null);

      expectCommentError(
        () => createComment(student.id, lessonId, "B", reply.id, null),
        400
      );
    });

    it("rejects a reply to a comment on another lesson", () => {
      const parent = createComment(student.id, lessonId, "Q", null, null);
      const mod = testDb.select().from(schema.modules).get()!;
      const otherLesson = createLesson(mod.id, "Other Lesson");

      expectCommentError(
        () => createComment(student.id, otherLesson.id, "A", parent.id, null),
        404
      );
    });

    it("rejects a reply to a deleted comment", () => {
      const parent = createComment(student.id, lessonId, "Q", null, null);
      createComment(otherStudent.id, lessonId, "A", parent.id, null);
      deleteComment(student.id, lessonId, parent.id, null);

      expectCommentError(
        () => createComment(otherStudent.id, lessonId, "B", parent.id, null),
        404
      );
    });
  });

  describe("updateComment", () => {
    it("updates the author's comment and records the edit", () => {
      const comment = createComment(student.id, lessonId, "Old", null, null);

      const updated = updateComment(student.id, lessonId, comment.id, " New ", null);

      expect(updated.content).toBe("New");
      expect(updated.editedAt).not.toBeNull();
    });

    it("doesn't record an edit when the text is unchanged", () => {
      const comment = createComment(student.id, lessonId, "Same", null, null);

      const updated = updateComment(student.id, lessonId, comment.id, "Same", null);

      expect(updated.editedAt).toBeNull();
    });

    it("rejects other students, moderators and admins", () => {
      const comment = createComment(student.id, lessonId, "Mine", null, null);

      for (const userId of [otherStudent.id, base.instructor.id, admin.id]) {
        expectCommentError(
          () => updateComment(userId, lessonId, comment.id, "Changed", null),
          403
        );
      }
      expect(findRow(comment.id)?.content).toBe("Mine");
    });

    it("rejects edits on closed courses", () => {
      const comment = createComment(student.id, lessonId, "Mine", null, null);
      setCourseStatus(schema.CourseStatus.Archived);

      expectCommentError(
        () => updateComment(student.id, lessonId, comment.id, "New", null),
        403
      );
    });

    it("rejects a comment id from another lesson", () => {
      const comment = createComment(student.id, lessonId, "Mine", null, null);
      const mod = testDb.select().from(schema.modules).get()!;
      const otherLesson = createLesson(mod.id, "Other Lesson");

      expectCommentError(
        () => updateComment(student.id, otherLesson.id, comment.id, "New", null),
        404
      );
    });

    it("rejects edits to deleted comments", () => {
      const parent = createComment(student.id, lessonId, "Q", null, null);
      createComment(otherStudent.id, lessonId, "A", parent.id, null);
      deleteComment(student.id, lessonId, parent.id, null);

      expectCommentError(
        () => updateComment(student.id, lessonId, parent.id, "Back", null),
        404
      );
    });
  });

  describe("deleteComment", () => {
    it("removes a comment with no replies", () => {
      const comment = createComment(student.id, lessonId, "Bye", null, null);

      deleteComment(student.id, lessonId, comment.id, null);

      expect(findRow(comment.id)).toBeUndefined();
    });

    it("keeps a comment with replies as a cleared placeholder", () => {
      const parent = createComment(student.id, lessonId, "Secret", null, null);
      const reply = createComment(otherStudent.id, lessonId, "A", parent.id, null);

      deleteComment(student.id, lessonId, parent.id, null);

      const row = findRow(parent.id);
      expect(row?.deletedAt).not.toBeNull();
      expect(row?.content).toBe("");
      expect(findRow(reply.id)).toBeDefined();
    });

    it("keeps a placeholder until its last reply is removed", () => {
      const parent = createComment(student.id, lessonId, "Q", null, null);
      const first = createComment(otherStudent.id, lessonId, "A", parent.id, null);
      const second = createComment(otherStudent.id, lessonId, "B", parent.id, null);
      deleteComment(student.id, lessonId, parent.id, null);

      deleteComment(otherStudent.id, lessonId, first.id, null);
      expect(findRow(parent.id)).toBeDefined();

      deleteComment(otherStudent.id, lessonId, second.id, null);
      expect(findRow(parent.id)).toBeUndefined();
    });

    it("keeps a live parent when its last reply is removed", () => {
      const parent = createComment(student.id, lessonId, "Q", null, null);
      const reply = createComment(otherStudent.id, lessonId, "A", parent.id, null);

      deleteComment(otherStudent.id, lessonId, reply.id, null);

      expect(findRow(parent.id)?.content).toBe("Q");
    });

    it("lets the course's instructor and admins delete any comment", () => {
      const first = createComment(student.id, lessonId, "One", null, null);
      const second = createComment(student.id, lessonId, "Two", null, null);

      deleteComment(base.instructor.id, lessonId, first.id, null);
      deleteComment(admin.id, lessonId, second.id, null);

      expect(findRow(first.id)).toBeUndefined();
      expect(findRow(second.id)).toBeUndefined();
    });

    it("rejects other students", () => {
      const comment = createComment(student.id, lessonId, "Mine", null, null);

      expectCommentError(
        () => deleteComment(otherStudent.id, lessonId, comment.id, null),
        403
      );
      expect(findRow(comment.id)).toBeDefined();
    });

    it("still allows deletes on closed courses", () => {
      const own = createComment(student.id, lessonId, "Mine", null, null);
      const other = createComment(otherStudent.id, lessonId, "Theirs", null, null);
      setCourseStatus(schema.CourseStatus.Archived);

      deleteComment(student.id, lessonId, own.id, null);
      deleteComment(base.instructor.id, lessonId, other.id, null);

      expect(findRow(own.id)).toBeUndefined();
      expect(findRow(other.id)).toBeUndefined();
    });

    it("blocks authors who've lost access", () => {
      const comment = createComment(student.id, lessonId, "Mine", null, null);
      makePppPurchase(student.id);

      expectCommentError(
        () => deleteComment(student.id, lessonId, comment.id, "US"),
        403
      );
    });

    it("rejects a comment that's already deleted", () => {
      const parent = createComment(student.id, lessonId, "Q", null, null);
      createComment(otherStudent.id, lessonId, "A", parent.id, null);
      deleteComment(student.id, lessonId, parent.id, null);

      expectCommentError(
        () => deleteComment(student.id, lessonId, parent.id, null),
        404
      );
    });
  });

  describe("getLessonComments", () => {
    it("returns no comments to users without access", () => {
      createComment(student.id, lessonId, "Private", null, null);

      expect(getLessonComments(outsider.id, lessonId, null).comments).toEqual([]);
      expect(getLessonComments(null, lessonId, null).comments).toEqual([]);
    });

    it("returns no comments to students blocked by the PPP check", () => {
      createComment(otherStudent.id, lessonId, "Private", null, null);
      makePppPurchase(student.id);

      expect(getLessonComments(student.id, lessonId, "US").comments).toEqual([]);
    });

    it("orders top-level newest first and replies oldest first", () => {
      const first = createComment(student.id, lessonId, "First", null, null);
      createComment(student.id, lessonId, "Second", null, null);
      createComment(otherStudent.id, lessonId, "Reply 1", first.id, null);
      createComment(otherStudent.id, lessonId, "Reply 2", first.id, null);

      const { comments } = getLessonComments(student.id, lessonId, null);

      expect(comments.map((c) => c.content)).toEqual(["Second", "First"]);
      expect(comments[1].replies.map((c) => c.content)).toEqual([
        "Reply 1",
        "Reply 2",
      ]);
    });

    it("only returns comments for the given lesson", () => {
      const mod = testDb.select().from(schema.modules).get()!;
      const otherLesson = createLesson(mod.id, "Other Lesson");
      createComment(student.id, otherLesson.id, "Elsewhere", null, null);

      expect(getLessonComments(student.id, lessonId, null).comments).toEqual([]);
    });

    it("hides the author of a deleted comment", () => {
      const parent = createComment(student.id, lessonId, "Secret", null, null);
      createComment(otherStudent.id, lessonId, "A", parent.id, null);
      deleteComment(student.id, lessonId, parent.id, null);

      const [view] = getLessonComments(admin.id, lessonId, null).comments;

      expect(view.deleted).toBe(true);
      expect(view.author).toBeNull();
      expect(view.content).toBe("");
      expect(view.canEdit).toBe(false);
      expect(view.canDelete).toBe(false);
      expect(view.canReply).toBe(false);
      expect(view.replies).toHaveLength(1);
    });

    it("marks only the course's instructor as an instructor", () => {
      createComment(base.instructor.id, lessonId, "Instructor", null, null);
      createComment(admin.id, lessonId, "Admin", null, null);
      createComment(student.id, lessonId, "Student", null, null);

      const { comments } = getLessonComments(student.id, lessonId, null);

      expect(comments.map((c) => c.author?.isInstructor)).toEqual([
        false,
        false,
        true,
      ]);
    });

    it("sets per-comment permissions for the viewer", () => {
      const own = createComment(student.id, lessonId, "Own", null, null);
      const reply = createComment(student.id, lessonId, "Reply", own.id, null);
      createComment(otherStudent.id, lessonId, "Other", null, null);

      const { comments } = getLessonComments(student.id, lessonId, null);
      const other = comments.find((c) => c.content === "Other")!;
      const mine = comments.find((c) => c.id === own.id)!;

      expect(mine).toMatchObject({ canEdit: true, canDelete: true, canReply: true });
      expect(other).toMatchObject({ canEdit: false, canDelete: false, canReply: true });
      expect(mine.replies[0].id).toBe(reply.id);
      expect(mine.replies[0].canReply).toBe(false);

      const asInstructor = getLessonComments(base.instructor.id, lessonId, null);
      expect(
        asInstructor.comments.find((c) => c.id === own.id)
      ).toMatchObject({ canEdit: false, canDelete: true });
    });

    it("only offers deleting on closed courses", () => {
      createComment(student.id, lessonId, "Own", null, null);
      setCourseStatus(schema.CourseStatus.Archived);

      const [view] = getLessonComments(student.id, lessonId, null).comments;

      expect(view).toMatchObject({ canEdit: false, canDelete: true, canReply: false });
    });
  });

  describe("getCommentCountsForLessons", () => {
    it("counts live comments and replies per lesson", () => {
      const parent = createComment(student.id, lessonId, "Q", null, null);
      createComment(otherStudent.id, lessonId, "A", parent.id, null);

      expect(getCommentCountsForLessons([lessonId])).toEqual({ [lessonId]: 2 });
    });

    it("leaves out deleted placeholders and empty lessons", () => {
      const parent = createComment(student.id, lessonId, "Q", null, null);
      createComment(otherStudent.id, lessonId, "A", parent.id, null);
      deleteComment(student.id, lessonId, parent.id, null);

      expect(getCommentCountsForLessons([lessonId, 9999])).toEqual({
        [lessonId]: 1,
      });
    });

    it("returns nothing for no lessons", () => {
      expect(getCommentCountsForLessons([])).toEqual({});
    });
  });

  describe("lesson deletion", () => {
    it("removes the lesson's comments and replies with it", () => {
      const parent = createComment(student.id, lessonId, "Q", null, null);
      const reply = createComment(otherStudent.id, lessonId, "A", parent.id, null);

      testDb
        .delete(schema.lessons)
        .where(eq(schema.lessons.id, lessonId))
        .run();

      expect(findRow(parent.id)).toBeUndefined();
      expect(findRow(reply.id)).toBeUndefined();
    });
  });
});
