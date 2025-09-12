#!/usr/bin/env node

// Simple test script to verify git integration
import { GitFlowManager } from './lib/git-flow.js';

async function testGitIntegration() {
  console.log('🧪 Testing Git Integration...\n');
  
  try {
    const gitFlow = new GitFlowManager('/Volumes/Projects/release-management-test');
    
    console.log('1. Checking if directory is a git repository...');
    const isGitRepo = await gitFlow.isGitRepository();
    console.log(`   ✅ Is Git Repository: ${isGitRepo}\n`);
    
    console.log('2. Getting git status...');
    const status = await gitFlow.getStatus();
    console.log(`   ✅ Current Branch: ${status.currentBranch}`);
    console.log(`   ✅ Is Clean: ${status.isClean}\n`);
    
    console.log('3. Verifying main/develop synchronization...');
    const syncResult = await gitFlow.verifyMainDevelopSync();
    console.log(`   ✅ Synchronized: ${syncResult.synchronized}`);
    console.log(`   ✅ Can Proceed: ${syncResult.canProceed}`);
    console.log(`   ✅ Message: ${syncResult.message}\n`);
    
    console.log('4. Getting branches...');
    const branches = await gitFlow.getBranches();
    console.log(`   ✅ Found ${branches.length} branches:`);
    branches.slice(0, 5).forEach(branch => {
      console.log(`      - ${branch.name} ${branch.current ? '(current)' : ''}`);
    });
    
    console.log('\n🎉 Git integration test completed successfully!');
    
  } catch (error) {
    console.error('❌ Git integration test failed:', error.message);
    process.exit(1);
  }
}

testGitIntegration();