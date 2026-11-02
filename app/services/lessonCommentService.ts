import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  CourseStatus,
  UserRole,
  courses,
  lessonComments,
  lessons,
  modules,
  users,
} from "~/db/schema";
import { MAX_COMMENT_LENGTH } from "~/lib/comments";
import { checkPppAccess } from "~/lib/ppp";
import { isUserEnrolled } from "~/services/enrollmentService";
import { findPurchase } from "~/services/purchaseService";

// ─── Lesson Comment Service ───
// Handles discussion threads on lessons: top-level comments with one level of
// replies. Permissions live here rather than in the route so they can be tested.
// `currentCountry` comes from resolveCountry, which needs the request.
// Uses positional parameters (project convention).

export class LessonCommentError extends Error {
  status: 400 | 403 | 404;

  constructor(message: string, status: 400 | 403 | 404) {
    super(message);
    this.name = "LessonCommentError";
    this.status = status;
  }
}

export type CommentAccess = {
  canRead: boolean;
  canWrite: boolean;
  canModerate: boolean;
};

export type LessonCommentView = {
  id: number;
  content: string;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  // Null once deleted, so a "[deleted]" placeholder doesn't name its author.
  author: {
    id: number;
    name: string;
    avatarUrl: string | null;
    isInstructor: boolean;
  } | null;
  canEdit: boolean;
  canDelete: boolean;
  canReply: boolean;
  replies: LessonCommentView[];
};

const NO_ACCESS: CommentAccess = {
  canRead: false,
  canWrite: false,
  canModerate: false,
};

function getCourseForLesson(lessonId: number) {
  return db
    .select({
      id: courses.id,
      instructorId: courses.instructorId,
      status: courses.status,
      price: courses.price,
      pppEnabled: courses.pppEnabled,
    })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(courses, eq(modules.courseId, courses.id))
    .where(eq(lessons.id, lessonId))
    .get();
}

/**
 * What a user can do with a lesson's comments. Staff are the course's
 * instructor and admins. Students must be enrolled, and not currently blocked
 * by the PPP country check. Only published courses accept new content.
 */
export function getCommentAccess(
  userId: number | null,
  lessonId: number,
  currentCountry: string | null
): CommentAccess {
  if (userId === null) return NO_ACCESS;

  const course = getCourseForLesson(lessonId);
  if (!course) return NO_ACCESS;

  const user = db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  if (!user) return NO_ACCESS;

  const isStaff =
    user.role === UserRole.Admin || course.instructorId === userId;

  if (!isStaff) {
    if (!isUserEnrolled(userId, course.id)) return NO_ACCESS;

    const purchase = findPurchase(userId, course.id);
    const { blocked } = checkPppAccess(
      course.price,
      course.pppEnabled,
      purchase?.country ?? null,
      currentCountry
    );
    if (blocked) return NO_ACCESS;
  }

  return {
    canRead: true,
    canWrite: course.status === CourseStatus.Published,
    canModerate: isStaff,
  };
}

function assertCanRead(access: CommentAccess) {
  if (!access.canRead) {
    throw new LessonCommentError(
      "You don't have access to this lesson's comments",
      403
    );
  }
}

function assertCanWrite(access: CommentAccess) {
  assertCanRead(access);
  if (!access.canWrite) {
    throw new LessonCommentError("Comments are closed for this course", 403);
  }
}

// Textareas submit line breaks as CRLF, which would otherwise count double
// towards the limit that the browser enforces with LF.
function normalizeContent(content: string) {
  const normalized = content.replace(/\r\n/g, "\n").trim();

  if (normalized.length === 0) {
    throw new LessonCommentError("Comment can't be empty", 400);
  }
  if (normalized.length > MAX_COMMENT_LENGTH) {
    throw new LessonCommentError(
      `Comment must be ${MAX_COMMENT_LENGTH} characters or fewer`,
      400
    );
  }

  return normalized;
}

function findCommentInLesson(lessonId: number, commentId: number) {
  const comment = db
    .select()
    .from(lessonComments)
    .where(
      and(
        eq(lessonComments.id, commentId),
        eq(lessonComments.lessonId, lessonId)
      )
    )
    .get();

  if (!comment || comment.deletedAt) {
    throw new LessonCommentError("Comment not found", 404);
  }

  return comment;
}

/**
 * A lesson's comment threads as this user may see them: newest first at the top
 * level, oldest first within replies. Empty when the user has no read access.
 */
export function getLessonComments(
  userId: number | null,
  lessonId: number,
  currentCountry: string | null
): { access: CommentAccess; comments: LessonCommentView[] } {
  const access = getCommentAccess(userId, lessonId, currentCountry);
  if (!access.canRead) return { access, comments: [] };

  const instructorId = getCourseForLesson(lessonId)?.instructorId;

  const rows = db
    .select({
      comment: lessonComments,
      authorName: users.name,
      authorAvatarUrl: users.avatarUrl,
    })
    .from(lessonComments)
    .innerJoin(users, eq(lessonComments.userId, users.id))
    .where(eq(lessonComments.lessonId, lessonId))
    .orderBy(lessonComments.createdAt, lessonComments.id)
    .all();

  const views = rows.map(
    ({ comment, authorName, authorAvatarUrl }): [number | null, LessonCommentView] => {
      const deleted = comment.deletedAt !== null;
      const isAuthor = comment.userId === userId;

      return [
        comment.parentId,
        {
          id: comment.id,
          content: comment.content,
          createdAt: comment.createdAt,
          editedAt: comment.editedAt,
          deleted,
          author: deleted
            ? null
            : {
                id: comment.userId,
                name: authorName,
                avatarUrl: authorAvatarUrl,
                isInstructor: comment.userId === instructorId,
              },
          canEdit: !deleted && isAuthor && access.canWrite,
          canDelete: !deleted && (isAuthor || access.canModerate),
          canReply: !deleted && comment.parentId === null && access.canWrite,
          replies: [],
        },
      ];
    }
  );

  const topLevel = new Map<number, LessonCommentView>();
  for (const [parentId, view] of views) {
    if (parentId === null) topLevel.set(view.id, view);
  }
  for (const [parentId, view] of views) {
    if (parentId !== null) topLevel.get(parentId)?.replies.push(view);
  }

  return { access, comments: [...topLevel.values()].reverse() };
}

/**
 * Live comments per lesson, so instructors can be warned before a delete that
 * would take comments with it. Lessons with no comments are absent.
 */
export function getCommentCountsForLessons(
  lessonIds: number[]
): Record<number, number> {
  if (lessonIds.length === 0) return {};

  const rows = db
    .select({
      lessonId: lessonComments.lessonId,
      count: sql<number>`count(*)`,
    })
    .from(lessonComments)
    .where(
      and(
        inArray(lessonComments.lessonId, lessonIds),
        isNull(lessonComments.deletedAt)
      )
    )
    .groupBy(lessonComments.lessonId)
    .all();

  return Object.fromEntries(rows.map((row) => [row.lessonId, row.count]));
}

/**
 * Adds a top-level comment, or a reply when parentId is given. Replies attach to
 * top-level comments only, and not to deleted ones.
 */
export function createComment(
  userId: number,
  lessonId: number,
  content: string,
  parentId: number | null,
  currentCountry: string | null
) {
  assertCanWrite(getCommentAccess(userId, lessonId, currentCountry));
  const normalized = normalizeContent(content);

  if (parentId !== null) {
    const parent = findCommentInLesson(lessonId, parentId);
    if (parent.parentId !== null) {
      throw new LessonCommentError("Replies can't have replies", 400);
    }
  }

  return db
    .insert(lessonComments)
    .values({ lessonId, userId, parentId, content: normalized })
    .returning()
    .get();
}

/**
 * Updates the user's own comment. Saving unchanged text doesn't count as an edit.
 */
export function updateComment(
  userId: number,
  lessonId: number,
  commentId: number,
  content: string,
  currentCountry: string | null
) {
  assertCanWrite(getCommentAccess(userId, lessonId, currentCountry));
  const comment = findCommentInLesson(lessonId, commentId);

  if (comment.userId !== userId) {
    throw new LessonCommentError("You can only edit your own comments", 403);
  }

  const normalized = normalizeContent(content);
  if (normalized === comment.content) return comment;

  return db
    .update(lessonComments)
    .set({ content: normalized, editedAt: new Date().toISOString() })
    .where(eq(lessonComments.id, commentId))
    .returning()
    .get();
}

/**
 * Deletes a comment for its author or a moderator, including on courses closed
 * to new comments. A comment with replies becomes a "[deleted]" placeholder with
 * its text cleared, and any other comment is removed outright. A placeholder is
 * removed along with its last reply.
 */
export function deleteComment(
  userId: number,
  lessonId: number,
  commentId: number,
  currentCountry: string | null
) {
  const access = getCommentAccess(userId, lessonId, currentCountry);
  assertCanRead(access);
  const comment = findCommentInLesson(lessonId, commentId);

  if (comment.userId !== userId && !access.canModerate) {
    throw new LessonCommentError("You can only delete your own comments", 403);
  }

  db.transaction((tx) => {
    const reply = tx
      .select({ id: lessonComments.id })
      .from(lessonComments)
      .where(eq(lessonComments.parentId, commentId))
      .get();

    if (reply) {
      tx.update(lessonComments)
        .set({ content: "", deletedAt: new Date().toISOString() })
        .where(eq(lessonComments.id, commentId))
        .run();
      return;
    }

    tx.delete(lessonComments).where(eq(lessonComments.id, commentId)).run();

    if (comment.parentId === null) return;

    const sibling = tx
      .select({ id: lessonComments.id })
      .from(lessonComments)
      .where(eq(lessonComments.parentId, comment.parentId))
      .get();

    if (!sibling) {
      tx.delete(lessonComments)
        .where(
          and(
            eq(lessonComments.id, comment.parentId),
            isNotNull(lessonComments.deletedAt)
          )
        )
        .run();
    }
  });
}
