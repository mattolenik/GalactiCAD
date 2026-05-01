#ifndef __KDTREE_H
#define __KDTREE_H

#include <stdio.h>
#include "datatype.h"
#include "common.h"
#include "misc.h"

#define KD_LEFTCHILD  		1
#define KD_RIGHTCHILD 		2
#define KD_LOWERBND   		0
#define KD_UPPERBND   		1
#define KD_NOTINTERSECT 	0
#define KD_PARTIALINTERSECT 	1
#define KD_INSIDE		2

class KdNode;
class KdTree;

typedef int (*InRegionProc)(const long&, void *);
typedef int (*BndIntersectProc)(void *, void *);
typedef int (*CompareProc)(const void *, const void *);
typedef void (*InitBndProc)(void *);
typedef void (*LimitBndProc)(void *, const long&, const int&);
typedef void (*WriteDataBlockProc)(FILE *fptr);
typedef void (*ReadDataBlockProc)(FILE *fptr);

// The Kd-tree is stored in a pointerless form. That is the whole
// tree is stored in a 1D array. Children of node i is at
// entry 2i (left) and 2i+1 (right)
// The reason to use a pointerless form is we always build a
// balanced tree. Hence, the vacancy will be minimized.
class KdNode
{
  private:
    long data;      // long data used as a index to a large array

  public:
    KdNode(){data=-1;};
    ~KdNode(){};
    void Init(long &indata){data=indata;};

  friend class KdTree;
};


class KdTree
{
  private:
    KdNode *tree;
    long treesize;
    int treeheight;                  // Height of the tree
    InRegionProc inregproc;          // IN_REGION
    BndIntersectProc bndintsctproc;  // BOUND_INTERSECT_REGION
    CompareProc compareproc;         // Compare 2 data unit
    InitBndProc initbndproc;  	     // Init the bound data proc
    LimitBndProc limitbndproc;       // Copy i-th key from 1 data to the bound
    WriteDataBlockProc writedataproc;// write data block to file
    ReadDataBlockProc readdataproc;
    int datasize;		     // no of byte allocated for 1 data unit
    int datasize2;		     // datasize * 2
    int keyno;			     // no of different keys or "k"
    long *result;		     // array to hold found data unit
    int maxresultcnt;		     // max no of element in result[]
    int resultcnt;		     // no of matched data found
    void *requirebound;		     // the input bound by user

  public:
    int CurrKey;  // value range from 0 to keyno-1
		  // indicate which key is used comparison at currlevel
  private:
    void InternalRegionSearch(int node, void *bound, int currkey);
    void Found(int node)
    {
      if (maxresultcnt<=resultcnt)
	ERREXIT("[KdTree::Found]: Caller does not allocate enough memory for searching\n");
      result[resultcnt++] = tree[node].data;
    };
    void CollectSubtree(int node);

  public:
    KdTree(int size, int nk, int ds,
	   CompareProc cp, InRegionProc ir, BndIntersectProc bi,
	   InitBndProc ib, LimitBndProc lb, WriteDataBlockProc wd,
	   ReadDataBlockProc rd);
    ~KdTree(){free(tree);};
    void BuildOptimalTree(int id, long *dataptr, int elmno, int currkey);
    void RegionSearch(long *searchresult, int maxno, int &resultno,
		      void *givenbound);
    void WriteKdTree(DCHAR *idxfile);
    void ReadKdTree(DCHAR *idxfile);
};






#endif


