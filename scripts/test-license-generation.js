#!/usr/bin/env node

/**
 * Test script to verify license generation works correctly
 */

const fs = require('fs');
const path = require('path');
const { generateNotices } = require('./generate-notices');

console.log('Testing license generation...\n');

// List some key production dependencies we expect to find
const expectedPackages = [
  '@anthropic-ai/sdk',
  'better-sqlite3-multiple-ciphers',
  'electron-updater',
  'react',
  'react-dom',
  'zustand',
  '@xterm/xterm'
];

// Check if node_modules exists
const nodeModulesExists = fs.existsSync(path.join(__dirname, '..', 'node_modules'));
if (!nodeModulesExists) {
  console.log('⚠️  Warning: node_modules not found. Run "pnpm install" first.\n');
}

// Run the generation
try {
  const startTime = Date.now();
  const notices = generateNotices();
  const duration = Date.now() - startTime;
  
  console.log(`\n✅ Generation completed in ${duration}ms`);
  
  // Check results
  const packageCount = (notices.match(/Package:/g) || []).length;
  console.log(`\n📦 Total packages found: ${packageCount}`);
  
  if (nodeModulesExists) {
    console.log('\n🔍 Checking for expected packages:');
    for (const pkg of expectedPackages) {
      if (notices.includes(`Package: ${pkg}`)) {
        console.log(`  ✅ ${pkg}`);
      } else {
        console.log(`  ❌ ${pkg} (not found)`);
      }
    }
  }
  
  // Check for potential issues
  console.log('\n⚠️  Checking for potential issues:');
  
  const missingLicenses = notices.match(/No license found for: .+/g) || [];
  if (missingLicenses.length > 0) {
    console.log(`  - ${missingLicenses.length} packages missing license information`);
  } else {
    console.log('  - All packages have license information ✅');
  }
  
  // Check file size
  const noticesPath = path.join(__dirname, '..', 'NOTICES');
  if (fs.existsSync(noticesPath)) {
    const stats = fs.statSync(noticesPath);
    console.log(`\n📄 NOTICES file size: ${(stats.size / 1024).toFixed(2)} KB`);
  }
  
  console.log('\n✅ Test completed successfully!');
} catch (error) {
  console.error('\n❌ Test failed:', error);
  process.exit(1);
}