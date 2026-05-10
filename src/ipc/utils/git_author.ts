import { getGithubUser } from "../handlers/github_handlers";

export async function getGitAuthor() {
  const user = await getGithubUser();
  const author = user
    ? {
        name: `[orianbuilder]`,
        email: user.email,
      }
    : {
        name: "[orianbuilder]",
        email: "git@orianbuilder.sh",
      };
  return author;
}
