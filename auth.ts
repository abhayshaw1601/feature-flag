import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/prisma";
import { ensureUserWorkspace } from "@/lib/provisioning";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  session: { strategy: "database" },
  trustHost: true,
  providers: [
    GitHub({
      clientId: process.env.AUTH_GITHUB_ID ?? "",
      clientSecret: process.env.AUTH_GITHUB_SECRET ?? "",
      issuer: "https://github.com/login/oauth",
    }),
  ],
  callbacks: {
    async signIn() {
      return true;
    },
    async session({ session, user }) {
      if (session.user) session.user.id = user.id;
      return session;
    },
  },
  events: {
    async signIn({ user, account, profile }) {
      if (account?.provider === "github" && user?.id) {
        const githubProfile = profile as typeof profile & {
          login?: string;
          avatar_url?: string | null;
        };
        await ensureUserWorkspace(
          user.id,
          {
            id: githubProfile?.id,
            login: githubProfile?.login,
            name: githubProfile?.name,
            email: githubProfile?.email,
            avatar_url:
              githubProfile?.avatar_url ??
              (typeof githubProfile?.image === "string" ? githubProfile.image : undefined),
          },
          account.providerAccountId,
        );
      }
    },
  },
  pages: { signIn: "/sign-in" },
});
