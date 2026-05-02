import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [
    'discord.js',
    '@discordjs/ws',
    '@discordjs/rest',
    '@discordjs/collection',
    '@discordjs/builders',
    'zlib-sync',
    'bufferutil',
    'utf-8-validate',
    'puppeteer',
    'puppeteer-core',
    'sharp',
  ],
};

export default nextConfig;
