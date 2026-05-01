#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <math.h>
#include "misc.h"
#include "datatype.h"
#include "kdtree.h"
#include "common.h"

#define KD_INVALID  -1



KdTree::KdTree(int size, int nk, int ds,
	       CompareProc cp, InRegionProc ir, BndIntersectProc bi,
	       InitBndProc ib, LimitBndProc lb, WriteDataBlockProc wd,
	       ReadDataBlockProc rd)
{
  int i, level;
  long invalid=KD_INVALID;

  inregproc = ir;
  bndintsctproc = bi;
  compareproc = cp;
  initbndproc = ib;
  limitbndproc = lb;
  writedataproc = wd;
  readdataproc = rd;
  keyno = nk;
  datasize = ds;
  datasize2 = ds<<1;
  for (level=0 ; size>0 ; level++)
    size >>= 1;

  treeheight = level;
  treesize = 1<<level;
  if ((tree=(KdNode*)malloc(sizeof(KdNode)*treesize))==NULL)
    ERREXIT("[KdTree::KdTree]: No enough memory\n");

  for (i=0 ; i<treesize ; i++)
    tree[i].Init(invalid);
}


// Input parameters
// 1) id	   ID or entry no of current node
// 2) dataarray[]  An 1D array of long index to data unit entry in another array.
//		   Each entry in the array points to 1 data unit.
// 3) elmno	   No of element in the array.
// 4) currkey      the id of key used at current level
//
void KdTree::BuildOptimalTree(int id, long *dataarray, int elmno, int currkey)
{
  if (elmno<=1)
  {
    tree[id].data = dataarray[0];
    return;
  }

  // set current compare key. So compareproc know which key to compare
  CurrKey = currkey;
  // Quicksort according to (CurrKey)th key
  qsort((void*)dataarray, elmno, sizeof(long), compareproc);

  int nextkey = (currkey+1)%keyno;
  int leftid = id<<1;
  int median=elmno>>1, leftno=median, rightno=elmno-median-1;

  tree[id].data = dataarray[leftno];

  // build left subtree
  if (leftno>0)
    BuildOptimalTree(leftid, dataarray, leftno, nextkey);

  // build right subtree
  if (rightno>0)
    BuildOptimalTree(leftid+1, &(dataarray[leftno+1]), rightno, nextkey);
}


// collect all node in the subtree given recursively
void KdTree::CollectSubtree(int node)
{
  int child=node<<1;
  char inside_tree = (child>>treeheight)==0;  
  // test 1 child is enough, since this is a binary tree. Even the rightmost
  // child in the same level cannot change the most significat bit on the
  // left

  Found(node);
  if (inside_tree && tree[child].data!=KD_INVALID)
    CollectSubtree(child);
  if (inside_tree && tree[child+1].data!=KD_INVALID)
    CollectSubtree(child+1);
}


void KdTree::RegionSearch(long *searchresult, int maxno, int &resultno,
			  void *givenbound)
{
  void *bound;
  result = searchresult;
  maxresultcnt = maxno;
  resultcnt = 0;
  requirebound = givenbound;
  if ((bound=(void*)malloc(datasize2))==NULL)
    ERREXIT("[KdTree::RegionSearch]: no enough memory\n");
  (*initbndproc)(bound);
  InternalRegionSearch(1, bound, 0);
  free(bound);
  resultno = resultcnt;
}


void KdTree::InternalRegionSearch(int node, void *bound, int currkey)
{
  int  nextkey, child=node<<1;
  char inside_tree = (child>>treeheight)==0;
  void *childbound;

  if ((*inregproc)(tree[node].data, requirebound))
    Found(node);

  if ((childbound=(void*)malloc(datasize2))==NULL)
    ERREXIT("[KdTree::InternalRegionSearch]: no enough memory\n");

  nextkey = (currkey+1)%keyno;
  if (inside_tree && tree[child].data!=KD_INVALID)  // left child exist
  {
    // copy old bound
    memcpy(childbound, bound, datasize2);
    // improve the upper bound of key j
    (*limitbndproc)(((char*)childbound)+datasize, tree[node].data, currkey);
    switch((*bndintsctproc)(childbound, requirebound))  // there is intersection
    {
      case KD_PARTIALINTERSECT:
	InternalRegionSearch(node<<1, childbound, nextkey);
	break;
      case KD_INSIDE:  // simply collect all node in the left subtree
	CollectSubtree(node<<1);
	break;
    }
  }

  if (inside_tree && tree[child+1].data!=KD_INVALID)  // right child exist
  {
    // copy old bound
    memcpy(childbound, bound, datasize2);
    // improve the lower bound of key j
    (*limitbndproc)(childbound, tree[node].data, currkey);
    switch((*bndintsctproc)(childbound, requirebound))  // there is intersection
    {
      case KD_PARTIALINTERSECT:
	InternalRegionSearch((node<<1)+1, childbound, nextkey);
	break;
      case KD_INSIDE:  // simply collect all node in the right subtree
	CollectSubtree((node<<1)+1);
	break;
    }
  }
  free(childbound);
}



void KdTree::WriteKdTree(DCHAR *idxfile)
{
  char notfile=FALSE;
  FILE *fptr;
  if (strncmp(idxfile,"stdout",10)==0)
  {
    fptr = stdout;
    notfile = TRUE;
  }
  else if ((fptr=fopen(idxfile,"wb"))==NULL)
    ERREXIT("[KdTree::WriteKdTree]: Cannot write kdtree to file\n");

  if (cp_fwrite(&treesize, sizeof(long), 1, fptr)!=1)
    ERREXIT("[KdTree::WriteKdTree]: Cannot write treesize to file\n");
  if (cp_fwrite(tree, sizeof(KdNode), treesize, fptr)!=treesize)
    ERREXIT("[KdTree::WriteKdTree]: Cannot write kdtree nodes to file\n");
  fprintf(stderr, "Node write = %li\n", treesize);
  (*writedataproc)(fptr);  // allow caller to write what he wants

  if (!notfile)
    fclose(fptr);
}



void KdTree::ReadKdTree(DCHAR *idxfile)
{
  FILE *fptr;
  long readno;
  char notfile=FALSE;

  fprintf(stderr, "treesize=%li, treeheight=%d\n", treesize, treeheight);

  if (strncmp(idxfile,"stdin",10)==0)
  {
    fptr = stdin;
    notfile = TRUE;
  }
  else if ((fptr=fopen(idxfile,"rb"))==NULL)
    ERREXIT("[KdTree::ReadKdTree]: Cannot read kdtree from file\n");

  if (cp_fread(&treesize, sizeof(long), 1, fptr)!=1)
    ERREXIT("[KdTree::ReadKdTree]: Cannot read treesize from file\n");
  if ((readno=fread(tree, sizeof(KdNode), treesize, fptr))!=treesize)  // exempted from using cp_fread
    fprintf(stderr, "[KdTree::ReadKdTree]: Cannot read kdtree nodes from file, read=%li, treesize=%li\n", readno, treesize);
#ifdef WIN32
  for (int i=0 ; i<treesize ; i++)
    SingleSwapByte((unsigned char*)&(tree[i].data), sizeof(long));
#endif
  (*readdataproc)(fptr);  // allow caller to write what he wants

  if (!notfile)
    fclose(fptr);
}
