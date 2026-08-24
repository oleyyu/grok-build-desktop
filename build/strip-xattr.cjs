// OneDrive (and Finder) stamp com.apple.FinderInfo / file-provider xattrs onto
// the tree. codesign --verify --deep then fails with "resource fork, Finder
// information, or similar detritus not allowed". Strip before signing.
const { execFileSync } = require('node:child_process')

exports.default = async function stripXattr(context) {
  console.log('afterPack: stripping xattrs in', context.appOutDir)
  execFileSync('xattr', ['-cr', context.appOutDir], { stdio: 'inherit' })
}
